"""Install workspace requirements and LSP helpers into the active session venv."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Awaitable, Callable

from clara_coder_backend.runtime.python_env import (
    _python_module_available,
    _run_subprocess_with_output,
    truncate_text,
)
from clara_coder_backend.session.domain import SessionState

_JEDI_LANGUAGE_SERVER_REQUIREMENT = 'jedi-language-server>=0.46,<0.47'
_MAX_DEPENDENCY_OUTPUT_CHARS = 80_000

__all__ = [
    'PythonDependencyOperationResult',
    'bootstrap_session_python_dependencies',
]


@dataclass
class PythonDependencyOperationResult:
    ok: bool
    summary: str
    installed_requirements: list[str] = field(default_factory=list)
    installed_packages: list[str] = field(default_factory=list)
    removed_packages: list[str] = field(default_factory=list)
    frozen_requirements: str = ''


def _format_dependency_summary(
    *,
    title: str,
    project_root_label: str,
    python_executable: Path,
    command_text: str,
    installed_requirements: list[str] | None = None,
    installed_packages: list[str] | None = None,
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
