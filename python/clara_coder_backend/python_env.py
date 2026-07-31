"""Workspace-local Python environment helpers for project review and tests."""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import subprocess
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Awaitable, Callable

from clara_coder_backend.config import CLARA_SUBPROCESS_TIMEOUT_SEC
from clara_coder_backend.domain import SessionState
from clara_coder_backend.tools.workspace import truncate_text

_MAX_BOOTSTRAP_OUTPUT_CHARS = 80_000
_PROCESS_PATH_LOCK = threading.RLock()
_ACTIVE_PROCESS_PYTHON_BIN_PATH = ''

logger = logging.getLogger('clara.python_env')

# Cap retained bytes from subprocess stdout when streaming or buffering (avoid OOM on huge CI logs).
_MAX_SUBPROCESS_CAPTURE_BYTES = 2 * 1024 * 1024


@dataclass
class PythonWorkspaceEnvResult:
    ok: bool
    project_root: Path | None
    project_root_label: str
    venv_path: Path | None
    python_executable: Path | None
    created: bool = False
    installed_requirements: list[str] = field(default_factory=list)
    installed_packages: list[str] = field(default_factory=list)
    summary: str = ''


def looks_like_pytest_project(root: Path) -> bool:
    return (
        root.is_dir()
        and (root / 'tests').is_dir()
        and (
            (root / 'clara_coder_backend').is_dir()
            or (root / 'src').is_dir()
            or (root / 'pyproject.toml').is_file()
            or (root / 'requirements.txt').is_file()
            or (root / 'requirements-dev.txt').is_file()
        )
    )


def _directory_has_python_files(root: Path) -> bool:
    if not root.is_dir():
        return False
    return any(path.is_file() for pattern in ('*.py', '*.pyi') for path in root.glob(pattern))


def looks_like_python_workspace(root: Path) -> bool:
    if looks_like_pytest_project(root):
        return True
    if _directory_has_python_files(root):
        return True
    for child_name in ('src', 'tests', 'app'):
        if _directory_has_python_files(root / child_name):
            return True
    return False


def workspace_python_bin_path(project_root: Path) -> Path:
    venv_path = workspace_venv_path(project_root)
    if sys.platform.startswith('win'):
        return venv_path / 'Scripts'
    return venv_path / 'bin'


def resolve_python_workspace_root(
    workspace_root: Path,
    *,
    allow_workspace_root_fallback: bool = False,
) -> tuple[Path | None, str]:
    if workspace_python_executable(workspace_root).is_file():
        return workspace_root, '.'
    if looks_like_python_workspace(workspace_root):
        return workspace_root, '.'
    python_subdir = workspace_root / 'python'
    if workspace_python_executable(python_subdir).is_file():
        return python_subdir, 'python/'
    if looks_like_python_workspace(python_subdir):
        return python_subdir, 'python/'
    if allow_workspace_root_fallback and workspace_root.is_dir():
        return workspace_root, '.'
    return None, ''


def workspace_venv_path(project_root: Path) -> Path:
    return project_root / '.venv'


def workspace_python_executable(project_root: Path) -> Path:
    venv_path = workspace_venv_path(project_root)
    if sys.platform.startswith('win'):
        return venv_path / 'Scripts' / 'python.exe'
    return venv_path / 'bin' / 'python'


def _effective_subprocess_timeout_sec(timeout_sec: float | None) -> float:
    """``timeout_sec`` explicit: use as-is (0 = unlimited). ``None`` = global default."""

    if timeout_sec is not None:
        return max(0.0, float(timeout_sec))
    return max(0.0, float(CLARA_SUBPROCESS_TIMEOUT_SEC))


async def _terminate_subprocess_tree(proc: asyncio.subprocess.Process) -> None:
    """Stop the process and any children (npm/yarn often spawn node as a child)."""

    if proc.returncode is not None:
        return
    pid = proc.pid
    if not isinstance(pid, int) or pid <= 0:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        return

    if sys.platform.startswith('win'):

        def _win_kill() -> None:
            flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
            try:
                subprocess.run(
                    ['taskkill', '/PID', str(pid), '/T', '/F'],
                    capture_output=True,
                    timeout=25,
                    creationflags=flags,
                )
            except (FileNotFoundError, OSError, subprocess.SubprocessError):
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass

        await asyncio.to_thread(_win_kill)
        try:
            await asyncio.wait_for(proc.wait(), timeout=12.0)
        except (asyncio.TimeoutError, ProcessLookupError):
            pass
    else:
        # Never signal a group we belong to: if the child shares our process
        # group (spawned without start_new_session=True), killpg would take
        # down this backend and its parent Electron/npm processes too.
        def _own_group(target_pid: int) -> bool:
            try:
                return os.getpgid(target_pid) == os.getpgid(0)
            except (ProcessLookupError, PermissionError, OSError):
                return True

        try:
            if _own_group(pid):
                proc.terminate()
            else:
                os.killpg(os.getpgid(pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            try:
                proc.kill()
            except ProcessLookupError:
                pass
        try:
            await asyncio.wait_for(proc.wait(), timeout=8.0)
        except (asyncio.TimeoutError, ProcessLookupError):
            try:
                if _own_group(pid):
                    proc.kill()
                else:
                    os.killpg(os.getpgid(pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
            try:
                await asyncio.wait_for(proc.wait(), timeout=4.0)
            except (asyncio.TimeoutError, ProcessLookupError):
                pass


async def _run_subprocess_with_output(
    args: list[str],
    *,
    cwd: Path,
    emit_chunk: Callable[[str], Awaitable[None]] | None = None,
    timeout_sec: float | None = None,
) -> tuple[int | None, str]:
    rendered_cmd = ' '.join(args)
    if emit_chunk is not None:
        await emit_chunk(f'$ {rendered_cmd}\n')
    limit = _effective_subprocess_timeout_sec(timeout_sec)
    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            cwd=str(cwd),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            start_new_session=True,
        )
    except OSError as exc:
        return None, f'Command failed to start: {exc}'

    async def _communicate_buffered() -> tuple[int | None, str]:
        try:
            if limit > 0:
                output_bytes, _ = await asyncio.wait_for(proc.communicate(), timeout=limit)
            else:
                output_bytes, _ = await proc.communicate()
        except asyncio.TimeoutError:
            raise
        out = output_bytes.decode('utf-8', errors='replace') if output_bytes else ''
        return proc.returncode, out

    async def _stream_stdout_bounded() -> bytes:
        """Read merged stdout+stderr while optionally emitting live chunks; cap retained size."""
        chunks: list[bytes] = []
        total = 0
        assert proc.stdout is not None
        while True:
            block = await proc.stdout.read(65536)
            if not block:
                break
            if total < _MAX_SUBPROCESS_CAPTURE_BYTES:
                take = block[: _MAX_SUBPROCESS_CAPTURE_BYTES - total]
                chunks.append(take)
                total += len(take)
            if emit_chunk is not None:
                text = block.decode('utf-8', errors='replace')
                if text:
                    await emit_chunk(text)
        return b''.join(chunks)

    async def _gather_stream_exit() -> tuple[int | None, str]:
        """Stream stdout until EOF while waiting for process exit (stderr merged into stdout)."""
        stream_task = asyncio.create_task(_stream_stdout_bounded())
        wait_task = asyncio.create_task(proc.wait())
        try:
            if limit > 0:
                await asyncio.wait_for(asyncio.gather(stream_task, wait_task), timeout=limit)
            else:
                await asyncio.gather(stream_task, wait_task)
        except asyncio.TimeoutError:
            for task in (stream_task, wait_task):
                if not task.done():
                    task.cancel()
            raise
        captured = stream_task.result() if stream_task.done() else b''
        code = wait_task.result() if wait_task.done() else proc.returncode
        text = captured.decode('utf-8', errors='replace') if captured else ''
        return code, text

    try:
        if emit_chunk is None:
            code, output = await _communicate_buffered()
            return code, output
        code, output = await _gather_stream_exit()
        return code, output
    except asyncio.TimeoutError:
        label = int(limit) if limit == int(limit) else limit
        logger.warning('Subprocess timed out after %ss: %s', label, rendered_cmd)
        await _terminate_subprocess_tree(proc)
        try:
            output_bytes, _ = await asyncio.wait_for(proc.communicate(), timeout=12.0)
        except (asyncio.TimeoutError, ProcessLookupError):
            output_bytes = b''
        msg = (
            f'Command timed out after {label}s (process tree terminated). '
            f'For long installs, raise CLARA_SUBPROCESS_TIMEOUT_SEC; for `npm run` scripts, '
            f'raise CLARA_NPM_SCRIPT_TIMEOUT_SEC.\nCommand: {rendered_cmd}'
        )
        partial = output_bytes.decode('utf-8', errors='replace') if output_bytes else ''
        if partial:
            msg = f'{msg}\n\nPartial output:\n{truncate_text(partial, 40_000)}'
        return None, msg


async def _python_module_available(python_executable: Path, module_name: str, *, cwd: Path) -> bool:
    code, _output = await _run_subprocess_with_output(
        [
            str(python_executable),
            '-c',
            (
                'import importlib.util, sys; '
                f"sys.exit(0 if importlib.util.find_spec('{module_name}') else 1)"
            ),
        ],
        cwd=cwd,
    )
    return code == 0


def _format_bootstrap_summary(
    *,
    project_root_label: str,
    venv_path: Path,
    python_executable: Path,
    created: bool,
    details: str = '',
) -> str:
    created_text = 'created' if created else 'reused'
    body = (
        'Python workspace environment summary:\n'
        f'- Workspace root: `{project_root_label}`\n'
        f'- Virtual environment: `{venv_path}` ({created_text})\n'
        f'- Python executable: `{python_executable}`\n'
    )
    trimmed = details.strip()
    if trimmed:
        body += f'\nCaptured output:\n{trimmed}'
    return truncate_text(body, _MAX_BOOTSTRAP_OUTPUT_CHARS)


async def ensure_python_workspace_env(
    project_root: Path,
    *,
    project_root_label: str,
    emit_chunk: Callable[[str], Awaitable[None]] | None = None,
) -> PythonWorkspaceEnvResult:
    venv_path = workspace_venv_path(project_root)
    python_executable = workspace_python_executable(project_root)
    created = False
    output_chunks: list[str] = []

    if venv_path.exists() and not venv_path.is_dir():
        return PythonWorkspaceEnvResult(
            ok=False,
            project_root=project_root,
            project_root_label=project_root_label,
            venv_path=venv_path,
            python_executable=None,
            summary=f'Tool error: expected `{venv_path}` to be a directory.',
        )

    if not venv_path.exists():
        created = True
        code, output = await _run_subprocess_with_output(
            [sys.executable, '-m', 'venv', '.venv'],
            cwd=project_root,
            emit_chunk=emit_chunk,
        )
        output_chunks.append(output)
        if code != 0:
            return PythonWorkspaceEnvResult(
                ok=False,
                project_root=project_root,
                project_root_label=project_root_label,
                venv_path=venv_path,
                python_executable=None,
                created=True,
                summary=truncate_text(
                    (
                        f'Tool error: could not create workspace virtual environment at `{venv_path}`.\n\n'
                        f'{output.strip() or f"`python -m venv .venv` exited with code {code}."}'
                    ),
                    _MAX_BOOTSTRAP_OUTPUT_CHARS,
                ),
            )

    if not python_executable.is_file():
        return PythonWorkspaceEnvResult(
            ok=False,
            project_root=project_root,
            project_root_label=project_root_label,
            venv_path=venv_path,
            python_executable=None,
            created=created,
            summary=f'Tool error: workspace virtual environment exists but `{python_executable}` is missing.',
        )

    return PythonWorkspaceEnvResult(
        ok=True,
        project_root=project_root,
        project_root_label=project_root_label,
        venv_path=venv_path,
        python_executable=python_executable,
        created=created,
        summary=_format_bootstrap_summary(
            project_root_label=project_root_label,
            venv_path=venv_path,
            python_executable=python_executable,
            created=created,
            details=''.join(output_chunks),
        ),
    )


def _prefixed_path(existing_path: str, *prefixes: str) -> str:
    normalized_seen: set[str] = set()
    ordered: list[str] = []
    for item in [*prefixes, *(existing_path.split(os.pathsep) if existing_path else [])]:
        cleaned = item.strip()
        if not cleaned:
            continue
        key = os.path.normcase(cleaned) if sys.platform.startswith('win') else cleaned
        if key in normalized_seen:
            continue
        normalized_seen.add(key)
        ordered.append(cleaned)
    return os.pathsep.join(ordered)


def with_subprocess_color_env(env: dict[str, str] | None = None) -> dict[str, str]:
    """Ensure piped tool subprocesses still emit ANSI colors for the in-app terminal UI."""
    out = dict(env or os.environ)
    out['FORCE_COLOR'] = '1'
    out['CLICOLOR_FORCE'] = '1'
    out['PY_COLORS'] = '1'
    out['TERM'] = 'xterm-256color'
    out.pop('NO_COLOR', None)
    return out


def build_workspace_python_env(
    venv_path: Path,
    *,
    base_env: dict[str, str] | None = None,
) -> dict[str, str]:
    env = with_subprocess_color_env(base_env)
    bin_path = str(workspace_python_bin_path(venv_path.parent))
    env['PATH'] = _prefixed_path(env.get('PATH', ''), bin_path)
    env['VIRTUAL_ENV'] = str(venv_path)
    env.pop('PYTHONHOME', None)
    return env


def activate_process_workspace_python_env(venv_path: Path) -> None:
    global _ACTIVE_PROCESS_PYTHON_BIN_PATH

    bin_path = str(workspace_python_bin_path(venv_path.parent))
    with _PROCESS_PATH_LOCK:
        path_value = os.environ.get('PATH', '')
        if _ACTIVE_PROCESS_PYTHON_BIN_PATH:
            segments = [item for item in path_value.split(os.pathsep) if item]
            filtered = [
                item
                for item in segments
                if os.path.normcase(item) != os.path.normcase(_ACTIVE_PROCESS_PYTHON_BIN_PATH)
            ]
            path_value = os.pathsep.join(filtered)
        os.environ['PATH'] = _prefixed_path(path_value, bin_path)
        os.environ['VIRTUAL_ENV'] = str(venv_path)
        os.environ.pop('PYTHONHOME', None)
        _ACTIVE_PROCESS_PYTHON_BIN_PATH = bin_path
    logger.info('activated workspace python PATH prefix=%s', bin_path)


def clear_session_python_workspace_env(session: SessionState) -> None:
    session.python_workspace_root = ''
    session.python_workspace_root_label = ''
    session.python_workspace_venv_path = ''
    session.python_workspace_python_executable = ''
    session.python_workspace_bin_path = ''
    session.python_workspace_env_summary = ''
    session.python_interpreter_choice_id = ''


def apply_session_python_workspace_env(session: SessionState, result: PythonWorkspaceEnvResult) -> None:
    if (
        not result.ok
        or result.project_root is None
        or result.venv_path is None
        or result.python_executable is None
    ):
        session.python_workspace_env_summary = result.summary
        return
    session.python_workspace_root = str(result.project_root)
    session.python_workspace_root_label = result.project_root_label
    session.python_workspace_venv_path = str(result.venv_path)
    session.python_workspace_python_executable = str(result.python_executable)
    session.python_workspace_bin_path = str(workspace_python_bin_path(result.project_root))
    session.python_workspace_env_summary = result.summary
    activate_process_workspace_python_env(result.venv_path)


def session_workspace_subprocess_env(session: SessionState) -> dict[str, str] | None:
    if not session.python_workspace_venv_path:
        return None
    return build_workspace_python_env(Path(session.python_workspace_venv_path))


async def ensure_session_python_workspace_env(
    session: SessionState,
    *,
    allow_workspace_root_fallback: bool = False,
    bootstrap_dependencies: bool = False,
    emit_chunk: Callable[[str], Awaitable[None]] | None = None,
) -> PythonWorkspaceEnvResult | None:
    workspace_path = (session.workspace_path or '').strip()
    if not workspace_path:
        clear_session_python_workspace_env(session)
        return None
    workspace_root = Path(workspace_path).resolve()
    project_root, project_root_label = resolve_python_workspace_root(
        workspace_root,
        allow_workspace_root_fallback=allow_workspace_root_fallback,
    )
    if project_root is None:
        clear_session_python_workspace_env(session)
        return None
    result = await ensure_python_workspace_env(
        project_root,
        project_root_label=project_root_label,
        emit_chunk=emit_chunk,
    )
    if result.ok:
        apply_session_python_workspace_env(session, result)
        if bootstrap_dependencies:
            from clara_coder_backend.tools.python_deps import bootstrap_session_python_dependencies

            dep_result = await bootstrap_session_python_dependencies(session, emit_chunk=emit_chunk)
            if dep_result is not None:
                result.installed_requirements = dep_result.installed_requirements
                result.installed_packages = dep_result.installed_packages
                result.summary = (
                    f'{result.summary}\n\n{dep_result.summary}'
                    if dep_result.summary.strip()
                    else result.summary
                )
                session.python_workspace_env_summary = result.summary
                if not dep_result.ok:
                    result.ok = False
    else:
        clear_session_python_workspace_env(session)
        session.python_workspace_env_summary = result.summary
    return result
