"""Workspace Python dependency-management agent and tools."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated, Awaitable, Callable

from langchain_core.tools import tool

from nemo_backend.accept_command import ACCEPT_COMMAND_KIND_PYTHON_DEPENDENCY
from nemo_backend.deferred_tool_hitl import maybe_await_hitl_for_deferred_tool
from nemo_backend.domain import SessionState
from nemo_backend.python_env import (
    _python_module_available,
    _run_subprocess_with_output,
    truncate_text,
)
from nemo_backend.state import current_session_id, get_session, mutation_tools_blocked_reason
from nemo_backend.tools.tool_conventions import describe

INSTALL_PYTHON_PACKAGES_NAME = 'install_python_packages'
REMOVE_PYTHON_PACKAGES_NAME = 'remove_python_packages'
INSTALL_PYTHON_REQUIREMENTS_FILE_NAME = 'install_python_requirements_file'
FREEZE_PYTHON_REQUIREMENTS_NAME = 'freeze_python_requirements'
WRITE_FROZEN_PYTHON_REQUIREMENTS_FILE_NAME = 'write_frozen_python_requirements_file'
BOOTSTRAP_PYTHON_TESTING_DEPENDENCIES_NAME = 'bootstrap_python_testing_dependencies'

_JEDI_LANGUAGE_SERVER_REQUIREMENT = 'jedi-language-server>=0.46,<0.47'
_MAX_DEPENDENCY_OUTPUT_CHARS = 80_000
_PENDING_KIND_INSTALL_PACKAGES = 'install_packages'
_PENDING_KIND_REMOVE_PACKAGES = 'remove_packages'
_PENDING_KIND_INSTALL_REQUIREMENTS = 'install_requirements'
_PENDING_KIND_WRITE_FROZEN_REQUIREMENTS = 'write_frozen_requirements'
_BOOTSTRAP_ONLY_PACKAGES = {'jedi-language-server'}

__all__ = [
    'BOOTSTRAP_PYTHON_TESTING_DEPENDENCIES_NAME',
    'FREEZE_PYTHON_REQUIREMENTS_NAME',
    'INSTALL_PYTHON_PACKAGES_NAME',
    'INSTALL_PYTHON_REQUIREMENTS_FILE_NAME',
    'REMOVE_PYTHON_PACKAGES_NAME',
    'bootstrap_session_python_dependencies',
    'execute_pending_python_dependency_request',
    'freeze_python_requirements_tool',
    'install_python_packages_tool',
    'install_python_requirements_file_tool',
    'python_dependency_tools',
    'remove_python_packages_tool',
    'write_frozen_python_requirements_file_tool',
]


@dataclass
class PythonDependencyOperationResult:
    ok: bool
    summary: str
    installed_requirements: list[str] = field(default_factory=list)
    installed_packages: list[str] = field(default_factory=list)
    removed_packages: list[str] = field(default_factory=list)
    frozen_requirements: str = ''


def _normalize_packages(packages: list[str]) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for raw in packages:
        cleaned = str(raw or '').strip()
        if not cleaned:
            continue
        key = cleaned.lower()
        if key in seen:
            continue
        seen.add(key)
        normalized.append(cleaned)
    return normalized


def _render_command(python_executable: Path, args: list[str]) -> str:
    return ' '.join([str(python_executable), '-m', 'pip', *args])


def _format_dependency_summary(
    *,
    title: str,
    project_root_label: str,
    python_executable: Path,
    command_text: str,
    installed_requirements: list[str] | None = None,
    installed_packages: list[str] | None = None,
    removed_packages: list[str] | None = None,
    frozen_requirements: str = '',
    written_requirements_file: str = '',
    details: str = '',
) -> str:
    body = (
        f'{title}:\n'
        f'- Workspace root: `{project_root_label}`\n'
        f'- Python executable: `{python_executable}`\n'
        f'- Command: `{command_text}`\n'
    )
    if installed_requirements is not None:
        req_text = ', '.join(f'`{item}`' for item in installed_requirements) if installed_requirements else '(none)'
        body += f'- Requirement files installed: {req_text}\n'
    if installed_packages is not None:
        pkg_text = ', '.join(f'`{item}`' for item in installed_packages) if installed_packages else '(none)'
        body += f'- Packages installed: {pkg_text}\n'
    if removed_packages is not None:
        removed_text = ', '.join(f'`{item}`' for item in removed_packages) if removed_packages else '(none)'
        body += f'- Packages removed: {removed_text}\n'
    if written_requirements_file.strip():
        body += f'- Requirements file written: `{written_requirements_file.strip()}`\n'
    if frozen_requirements.strip():
        body += f'\nFrozen requirements:\n{frozen_requirements.strip()}'
    trimmed = details.strip()
    if trimmed:
        body += f'\nCaptured output:\n{trimmed}'
    return truncate_text(body, _MAX_DEPENDENCY_OUTPUT_CHARS)


def _workspace_context_from_session(session: SessionState) -> tuple[Path, str, Path] | tuple[None, str, None]:
    project_root_raw = (session.python_workspace_root or '').strip()
    python_raw = (session.python_workspace_python_executable or '').strip()
    project_root_label = (session.python_workspace_root_label or '.').strip() or '.'
    if not project_root_raw or not python_raw:
        return None, 'Tool error: no active workspace Python environment is attached to this session.', None
    project_root = Path(project_root_raw)
    python_executable = Path(python_raw)
    if not project_root.is_dir():
        return None, f'Tool error: workspace Python project root is unavailable: `{project_root}`.', None
    if not python_executable.is_file():
        return None, f'Tool error: workspace Python executable is unavailable: `{python_executable}`.', None
    return project_root, project_root_label, python_executable


async def _run_pip_operation(
    session: SessionState,
    *,
    title: str,
    pip_args: list[str],
    emit_chunk: Callable[[str], Awaitable[None]] | None = None,
    installed_requirements: list[str] | None = None,
    installed_packages: list[str] | None = None,
    removed_packages: list[str] | None = None,
) -> PythonDependencyOperationResult:
    project_root, project_root_label, python_executable = _workspace_context_from_session(session)
    if project_root is None or python_executable is None:
        return PythonDependencyOperationResult(ok=False, summary=project_root_label)
    command_text = _render_command(python_executable, pip_args)
    code, output = await _run_subprocess_with_output(
        [str(python_executable), '-m', 'pip', *pip_args],
        cwd=project_root,
        emit_chunk=emit_chunk,
    )
    if code != 0:
        return PythonDependencyOperationResult(
            ok=False,
            summary=truncate_text(
                (
                    f'Tool error: `{command_text}` failed in `{project_root_label}`.\n\n'
                    f'{output.strip() or f"`pip` exited with code {code}."}'
                ),
                _MAX_DEPENDENCY_OUTPUT_CHARS,
            ),
            installed_requirements=installed_requirements or [],
            installed_packages=installed_packages or [],
            removed_packages=removed_packages or [],
        )
    return PythonDependencyOperationResult(
        ok=True,
        summary=_format_dependency_summary(
            title=title,
            project_root_label=project_root_label,
            python_executable=python_executable,
            command_text=command_text,
            installed_requirements=installed_requirements,
            installed_packages=installed_packages,
            removed_packages=removed_packages,
            details=output,
        ),
        installed_requirements=installed_requirements or [],
        installed_packages=installed_packages or [],
        removed_packages=removed_packages or [],
    )


async def bootstrap_session_python_dependencies(
    session: SessionState,
    *,
    emit_chunk: Callable[[str], Awaitable[None]] | None = None,
) -> PythonDependencyOperationResult | None:
    """Install workspace requirements and test/LSP helpers into the active session venv."""

    project_root, project_root_label, python_executable = _workspace_context_from_session(session)
    if project_root is None or python_executable is None:
        return None

    installed_requirements: list[str] = []
    installed_packages: list[str] = []
    output_chunks: list[str] = []

    for requirement_file in ('requirements.txt', 'requirements-dev.txt'):
        req_path = project_root / requirement_file
        if not req_path.is_file():
            continue
        code, output = await _run_subprocess_with_output(
            [str(python_executable), '-m', 'pip', 'install', '-r', requirement_file],
            cwd=project_root,
            emit_chunk=emit_chunk,
        )
        output_chunks.append(output)
        if code != 0:
            return PythonDependencyOperationResult(
                ok=False,
                summary=truncate_text(
                    (
                        f'Tool error: could not install `{requirement_file}` into `{session.python_workspace_venv_path}`.\n\n'
                        f'{output.strip() or f"`pip install -r {requirement_file}` exited with code {code}."}'
                    ),
                    _MAX_DEPENDENCY_OUTPUT_CHARS,
                ),
                installed_requirements=installed_requirements,
                installed_packages=installed_packages,
            )
        installed_requirements.append(requirement_file)

    if not await _python_module_available(python_executable, 'jedi_language_server', cwd=project_root):
        code, output = await _run_subprocess_with_output(
            [str(python_executable), '-m', 'pip', 'install', _JEDI_LANGUAGE_SERVER_REQUIREMENT],
            cwd=project_root,
            emit_chunk=emit_chunk,
        )
        output_chunks.append(output)
        if code != 0:
            return PythonDependencyOperationResult(
                ok=False,
                summary=truncate_text(
                    (
                        f'Tool error: could not install `{_JEDI_LANGUAGE_SERVER_REQUIREMENT}` into '
                        f'`{session.python_workspace_venv_path}`.\n\n'
                        f'{output.strip() or "`pip install jedi-language-server` failed."}'
                    ),
                    _MAX_DEPENDENCY_OUTPUT_CHARS,
                ),
                installed_requirements=installed_requirements,
                installed_packages=installed_packages,
            )
        installed_packages.append('jedi-language-server')

    return PythonDependencyOperationResult(
        ok=True,
        summary=_format_dependency_summary(
            title='Python dependency agent summary',
            project_root_label=project_root_label,
            python_executable=python_executable,
            command_text='bootstrap workspace requirements and testing helpers',
            installed_requirements=installed_requirements,
            installed_packages=installed_packages,
            details=''.join(output_chunks),
        ),
        installed_requirements=installed_requirements,
        installed_packages=installed_packages,
    )


def _pending_dependency_command(
    session: SessionState,
    *,
    title: str,
    message: str,
    confirm_label: str,
    command_text: str,
    details: list[str],
    action_kind: str,
    packages: list[str] | None = None,
    requirements_file: str = '',
) -> str:
    session.pending_accept_command_request = {
        'request_id': uuid.uuid4().hex,
        'kind': ACCEPT_COMMAND_KIND_PYTHON_DEPENDENCY,
        'title': title,
        'message': message,
        'confirm_label': confirm_label,
        'cancel_label': 'Cancel',
        'command_text': command_text,
        'details': details,
        'cancel_note': f'User cancelled the pending Python dependency action: {title}.',
        'action': {
            'kind': action_kind,
            'packages': packages or [],
            'requirements_file': requirements_file,
        },
    }
    return (
        f'Pending user confirmation for Python dependency action `{title}`. '
        'The UI will ask the user to confirm before the dependency command runs.'
    )


async def execute_pending_python_dependency_request(session: SessionState, pending: dict) -> str:
    """Run a previously staged Python dependency action after the user accepts it."""

    action = pending.get('action') if isinstance(pending.get('action'), dict) else {}
    kind = str(action.get('kind') or '')
    packages = _normalize_packages(list(action.get('packages') or []))
    requirements_file = str(action.get('requirements_file') or '').strip()

    if kind == _PENDING_KIND_INSTALL_PACKAGES:
        result = await _run_pip_operation(
            session,
            title='Python dependency install summary',
            pip_args=['install', *packages],
            installed_packages=packages,
        )
        return result.summary
    if kind == _PENDING_KIND_REMOVE_PACKAGES:
        result = await _run_pip_operation(
            session,
            title='Python dependency removal summary',
            pip_args=['uninstall', '-y', *packages],
            removed_packages=packages,
        )
        return result.summary
    if kind == _PENDING_KIND_INSTALL_REQUIREMENTS:
        result = await _run_pip_operation(
            session,
            title='Python requirements install summary',
            pip_args=['install', '-r', requirements_file],
            installed_requirements=[requirements_file],
        )
        return result.summary
    if kind == _PENDING_KIND_WRITE_FROZEN_REQUIREMENTS:
        project_root, project_root_label, python_executable = _workspace_context_from_session(session)
        if project_root is None or python_executable is None:
            return project_root_label
        output_path, output_error, cleaned_output = _resolve_requirements_output_path(
            project_root,
            requirements_file or 'requirements.txt',
        )
        if output_error:
            return output_error
        assert output_path is not None
        command_text = _render_command(python_executable, ['freeze'])
        code, output = await _run_subprocess_with_output(
            [str(python_executable), '-m', 'pip', 'freeze'],
            cwd=project_root,
        )
        if code != 0:
            return truncate_text(
                f'Tool error: `{command_text}` failed.\n\n{output.strip() or f"`pip freeze` exited with code {code}."}',
                _MAX_DEPENDENCY_OUTPUT_CHARS,
            )
        filtered = _filtered_freeze_output(output)
        text_to_write = f'{filtered}\n' if filtered else ''
        try:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(text_to_write, encoding='utf-8')
        except OSError as exc:
            return f'Tool error: could not write `{cleaned_output}` ({exc}).'
        return _format_dependency_summary(
            title='Python dependency freeze file summary',
            project_root_label=project_root_label,
            python_executable=python_executable,
            command_text=command_text,
            frozen_requirements=filtered,
            written_requirements_file=cleaned_output,
        )
    return f'Tool error: unsupported pending Python dependency action `{kind or "unknown"}`.'


def _active_session_or_error() -> tuple[str | None, SessionState | None, str | None]:
    sid = (current_session_id.get() or '').strip()
    if not sid:
        return None, None, 'Tool error: no active session.'
    blocked = mutation_tools_blocked_reason(sid)
    if blocked:
        return sid, None, blocked
    return sid, get_session(sid), None


def _resolve_requirements_path(project_root: Path, requirements_file: str) -> tuple[Path | None, str | None]:
    cleaned = (requirements_file or '').strip().replace('\\', '/')
    if not cleaned:
        return None, 'Tool error: `requirements_file` is required.'
    candidate = (project_root / cleaned).resolve()
    try:
        candidate.relative_to(project_root.resolve())
    except ValueError:
        return None, 'Tool error: requirements file must stay inside the active Python workspace.'
    if not candidate.is_file():
        return None, f'Tool error: requirements file does not exist: `{cleaned}`.'
    return candidate, None


def _resolve_requirements_output_path(project_root: Path, output_file: str) -> tuple[Path | None, str | None, str]:
    cleaned = (output_file or 'requirements.txt').strip().replace('\\', '/')
    if not cleaned:
        cleaned = 'requirements.txt'
    candidate = (project_root / cleaned).resolve()
    try:
        candidate.relative_to(project_root.resolve())
    except ValueError:
        return None, 'Tool error: requirements output file must stay inside the active Python workspace.', cleaned
    return candidate, None, cleaned


def _filtered_freeze_output(raw_output: str) -> str:
    kept_lines: list[str] = []
    for line in raw_output.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        package_name = stripped
        for delimiter in ('==', '>=', '<=', '~=', '!=', '>', '<', '@'):
            if delimiter in package_name:
                package_name = package_name.split(delimiter, 1)[0]
                break
        if package_name.strip().lower() in _BOOTSTRAP_ONLY_PACKAGES:
            continue
        kept_lines.append(stripped)
    return '\n'.join(kept_lines)


@tool(INSTALL_PYTHON_PACKAGES_NAME, description=describe('Install packages into the current workspace `.venv` using the session Python interpreter.',
        when='adding runtime or dev dependencies.',
        not_='system Python or global pip.',
        shape='`packages` names (may include version specifiers); HITL confirm when auto-apply off.',))
async def install_python_packages_tool(
    packages: Annotated[list[str], 'package names (may include version specifiers)'],
) -> str:

    _sid, session, error = _active_session_or_error()
    if error:
        return error
    assert session is not None
    packages = _normalize_packages(packages)
    if not packages:
        return 'Tool error: at least one package is required.'
    project_root, project_root_label, python_executable = _workspace_context_from_session(session)
    if project_root is None or python_executable is None:
        return project_root_label
    if session.auto_apply_mode:
        result = await _run_pip_operation(
            session,
            title='Python dependency install summary',
            pip_args=['install', *packages],
            installed_packages=packages,
        )
        return result.summary
    return _pending_dependency_command(
        session,
        title='Install Python packages',
        message='Install package(s) into the active workspace virtual environment.',
        confirm_label='Install packages',
        command_text=_render_command(python_executable, ['install', *packages]),
        details=[
            f'Workspace root: `{project_root_label}`',
            f'Packages: {", ".join(f"`{item}`" for item in packages)}',
        ],
        action_kind=_PENDING_KIND_INSTALL_PACKAGES,
        packages=packages,
    )


@tool(REMOVE_PYTHON_PACKAGES_NAME, description=describe('Uninstall packages from the current workspace `.venv` using the session Python interpreter.',
        when='removing unused or conflicting dependencies.',
        not_='system Python or global pip.',
        shape='`packages` names; HITL confirm when auto-apply off.',))
async def remove_python_packages_tool(
    packages: Annotated[list[str], 'package names (may include version specifiers)'],
) -> str:

    _sid, session, error = _active_session_or_error()
    if error:
        return error
    assert session is not None
    packages = _normalize_packages(packages)
    if not packages:
        return 'Tool error: at least one package is required.'
    project_root, project_root_label, python_executable = _workspace_context_from_session(session)
    if project_root is None or python_executable is None:
        return project_root_label
    if session.auto_apply_mode:
        result = await _run_pip_operation(
            session,
            title='Python dependency removal summary',
            pip_args=['uninstall', '-y', *packages],
            removed_packages=packages,
        )
        return result.summary
    return _pending_dependency_command(
        session,
        title='Remove Python packages',
        message='Remove package(s) from the active workspace virtual environment.',
        confirm_label='Remove packages',
        command_text=_render_command(python_executable, ['uninstall', '-y', *packages]),
        details=[
            f'Workspace root: `{project_root_label}`',
            f'Packages: {", ".join(f"`{item}`" for item in packages)}',
        ],
        action_kind=_PENDING_KIND_REMOVE_PACKAGES,
        packages=packages,
    )


@tool(INSTALL_PYTHON_REQUIREMENTS_FILE_NAME, description=describe(
    'Install dependencies from a requirements file in the active workspace Python project.',
    when='syncing from `requirements.txt` or similar manifest.',
    not_='ad-hoc single packages (use `install_python_packages`).',
    shape='requirements file path inside the active Python project; HITL confirm when auto-apply off.',
))
async def install_python_requirements_file_tool(requirements_file: str) -> str:

    _sid, session, error = _active_session_or_error()
    if error:
        return error
    assert session is not None
    project_root, project_root_label, python_executable = _workspace_context_from_session(session)
    if project_root is None or python_executable is None:
        return project_root_label
    req_path, req_error = _resolve_requirements_path(project_root, requirements_file)
    if req_error:
        return req_error
    assert req_path is not None
    rel_req = req_path.relative_to(project_root.resolve()).as_posix()
    if session.auto_apply_mode:
        result = await _run_pip_operation(
            session,
            title='Python requirements install summary',
            pip_args=['install', '-r', rel_req],
            installed_requirements=[rel_req],
        )
        return result.summary
    return _pending_dependency_command(
        session,
        title='Install Python requirements file',
        message='Install dependencies from a requirements file into the active workspace virtual environment.',
        confirm_label='Install requirements',
        command_text=_render_command(python_executable, ['install', '-r', rel_req]),
        details=[
            f'Workspace root: `{project_root_label}`',
            f'Requirements file: `{rel_req}`',
        ],
        action_kind=_PENDING_KIND_INSTALL_REQUIREMENTS,
        requirements_file=rel_req,
    )


@tool(FREEZE_PYTHON_REQUIREMENTS_NAME, description=describe(
    'Return `pip freeze` output from the active workspace `.venv`.',
    when='inspecting installed versions before pinning.',
    not_='writing a file (use `write_frozen_python_requirements_file`).',
    shape='read-only snapshot of the session venv.',
))
async def freeze_python_requirements_tool() -> str:

    sid = (current_session_id.get() or '').strip()
    if not sid:
        return 'Tool error: no active session.'
    session = get_session(sid)
    project_root, project_root_label, python_executable = _workspace_context_from_session(session)
    if project_root is None or python_executable is None:
        return project_root_label
    code, output = await _run_subprocess_with_output(
        [str(python_executable), '-m', 'pip', 'freeze'],
        cwd=project_root,
    )
    command_text = _render_command(python_executable, ['freeze'])
    if code != 0:
        return truncate_text(
            f'Tool error: `{command_text}` failed.\n\n{output.strip() or f"`pip freeze` exited with code {code}."}',
            _MAX_DEPENDENCY_OUTPUT_CHARS,
        )
    return _format_dependency_summary(
        title='Python dependency freeze summary',
        project_root_label=project_root_label,
        python_executable=python_executable,
        command_text=command_text,
        frozen_requirements=output.strip(),
    )


@tool(WRITE_FROZEN_PYTHON_REQUIREMENTS_FILE_NAME, description=describe(
    'Run `pip freeze` and write filtered output to a requirements file in the active workspace.',
    when='pinning dependencies after installs or upgrades.',
    not_='installing packages (use `install_python_packages` or `install_python_requirements_file`).',
    shape='output file inside the active Python project (default `requirements.txt`); filters bootstrap-only packages; HITL confirm when auto-apply off.',
))
async def write_frozen_python_requirements_file_tool(output_file: str = 'requirements.txt') -> str:

    _sid, session, error = _active_session_or_error()
    if error:
        return error
    assert session is not None
    project_root, project_root_label, python_executable = _workspace_context_from_session(session)
    if project_root is None or python_executable is None:
        return project_root_label
    output_path, output_error, cleaned_output = _resolve_requirements_output_path(project_root, output_file)
    if output_error:
        return output_error
    assert output_path is not None
    command_text = _render_command(python_executable, ['freeze'])
    if not session.auto_apply_mode:
        return _pending_dependency_command(
            session,
            title='Write frozen Python requirements file',
            message='Generate a requirements file from the active workspace virtual environment using pip freeze.',
            confirm_label='Write requirements file',
            command_text=command_text,
            details=[
                f'Workspace root: `{project_root_label}`',
                f'Output file: `{cleaned_output}`',
            ],
            action_kind=_PENDING_KIND_WRITE_FROZEN_REQUIREMENTS,
            requirements_file=cleaned_output,
        )
    code, output = await _run_subprocess_with_output(
        [str(python_executable), '-m', 'pip', 'freeze'],
        cwd=project_root,
    )
    if code != 0:
        return truncate_text(
            f'Tool error: `{command_text}` failed.\n\n{output.strip() or f"`pip freeze` exited with code {code}."}',
            _MAX_DEPENDENCY_OUTPUT_CHARS,
        )
    filtered = _filtered_freeze_output(output)
    text_to_write = f'{filtered}\n' if filtered else ''
    try:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(text_to_write, encoding='utf-8')
    except OSError as exc:
        return f'Tool error: could not write `{cleaned_output}` ({exc}).'
    return _format_dependency_summary(
        title='Python dependency freeze file summary',
        project_root_label=project_root_label,
        python_executable=python_executable,
        command_text=command_text,
        frozen_requirements=filtered,
        written_requirements_file=cleaned_output,
    )


@tool(BOOTSTRAP_PYTHON_TESTING_DEPENDENCIES_NAME, description=describe(
    'Install workspace requirements, testing dependencies, and Python LSP helpers into the current workspace `.venv`.',
    when='preparing env for pytest, runtime checks via `run_command`, or LSP before project review.',
    not_='Node/npm setup.',
    shape='installs `requirements.txt`/`requirements-dev.txt` when present plus `jedi-language-server` and testing deps.',
))
async def bootstrap_python_testing_dependencies_tool() -> str:

    sid = (current_session_id.get() or '').strip()
    if not sid:
        return 'Tool error: no active session.'
    session = get_session(sid)
    pending = maybe_await_hitl_for_deferred_tool(
        session,
        tool_name=BOOTSTRAP_PYTHON_TESTING_DEPENDENCIES_NAME,
        tool_input={},
    )
    if pending:
        return pending
    result = await bootstrap_session_python_dependencies(session)
    if result is None:
        return 'Tool error: no active workspace Python environment is attached to this session.'
    return result.summary


def python_dependency_tools() -> tuple[list[object], dict[str, object]]:
    tools: list[object] = [
        install_python_packages_tool,
        remove_python_packages_tool,
        install_python_requirements_file_tool,
        freeze_python_requirements_tool,
        write_frozen_python_requirements_file_tool,
        bootstrap_python_testing_dependencies_tool,
    ]
    return tools, {tool_obj.name: tool_obj for tool_obj in tools}
