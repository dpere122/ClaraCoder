"""Install workspace requirements into the active session venv."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Awaitable, Callable

from clara_coder_backend.runtime.python_env import (
    _run_subprocess_with_output,
)
from clara_coder_backend.domain import SessionState
from clara_coder_backend.workspace.paths import truncate_text

_MAX_BOOTSTRAP_OUTPUT_CHARS = 80_000

__all__ = [
    'PythonBootstrapResult',
    'bootstrap_session_python_dependencies',
]


@dataclass
class PythonBootstrapResult:
    ok: bool
    summary: str
    installed_requirements: list[str] = field(default_factory=list)
    installed_packages: list[str] = field(default_factory=list)


def _format_bootstrap_summary(
    *,
    project_root_label: str,
    python_executable: Path,
    installed_requirements: list[str],
    installed_packages: list[str],
    details: str = '',
) -> str:
    req_text = ', '.join(f'`{item}`' for item in installed_requirements) if installed_requirements else '(none)'
    pkg_text = ', '.join(f'`{item}`' for item in installed_packages) if installed_packages else '(none)'
    body = (
        'Python workspace dependency bootstrap:\n'
        f'- Workspace root: `{project_root_label}`\n'
        f'- Python executable: `{python_executable}`\n'
        f'- Requirement files installed: {req_text}\n'
        f'- Packages installed: {pkg_text}\n'
    )
    trimmed = details.strip()
    if trimmed:
        body += f'\nCaptured output:\n{trimmed}'
    return truncate_text(body, _MAX_BOOTSTRAP_OUTPUT_CHARS)


def _workspace_context_from_session(session: SessionState) -> tuple[Path, str, Path] | None:
    project_root_raw = (session.python_workspace_root or '').strip()
    python_raw = (session.python_workspace_python_executable or '').strip()
    project_root_label = (session.python_workspace_root_label or '.').strip() or '.'
    if not project_root_raw or not python_raw:
        return None
    project_root = Path(project_root_raw)
    python_executable = Path(python_raw)
    if not project_root.is_dir() or not python_executable.is_file():
        return None
    return project_root, project_root_label, python_executable


async def bootstrap_session_python_dependencies(
    session: SessionState,
    *,
    emit_chunk: Callable[[str], Awaitable[None]] | None = None,
) -> PythonBootstrapResult | None:
    """Install workspace requirements into the active session venv."""

    context = _workspace_context_from_session(session)
    if context is None:
        return None
    project_root, project_root_label, python_executable = context

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
            return PythonBootstrapResult(
                ok=False,
                summary=truncate_text(
                    (
                        f'Tool error: could not install `{requirement_file}` into `{session.python_workspace_venv_path}`.\n\n'
                        f'{output.strip() or f"`pip install -r {requirement_file}` exited with code {code}."}'
                    ),
                    _MAX_BOOTSTRAP_OUTPUT_CHARS,
                ),
                installed_requirements=installed_requirements,
                installed_packages=installed_packages,
            )
        installed_requirements.append(requirement_file)

    return PythonBootstrapResult(
        ok=True,
        summary=_format_bootstrap_summary(
            project_root_label=project_root_label,
            python_executable=python_executable,
            installed_requirements=installed_requirements,
            installed_packages=installed_packages,
            details=''.join(output_chunks),
        ),
        installed_requirements=installed_requirements,
        installed_packages=installed_packages,
    )
