"""Workspace Node.js / npm / pnpm / Yarn dependency tools (TypeScript/JavaScript projects)."""

from __future__ import annotations

import json
import re
import shutil
import uuid
from pathlib import Path
from typing import Annotated, Any

from langchain_core.tools import tool

from clara_coder_backend.hitl.accept_command import ACCEPT_COMMAND_KIND_NODE_DEPENDENCY
from clara_coder_backend.session.domain import SessionState
from clara_coder_backend.session.config import CLARA_NPM_SCRIPT_TIMEOUT_SEC
from clara_coder_backend.runtime.python_env import _run_subprocess_with_output
from clara_coder_backend.tools.workspace import truncate_text, truncate_text_head_tail
from clara_coder_backend.session.state import current_session_id, get_session, mutation_tools_blocked_reason
from clara_coder_backend.tools.tool_conventions import describe

INSTALL_NPM_PACKAGES_NAME = 'install_npm_packages'
REMOVE_NPM_PACKAGES_NAME = 'remove_npm_packages'
NPM_INSTALL_PROJECT_NAME = 'npm_install_project'
RUN_NPM_SCRIPT_NAME = 'run_npm_script'

_MAX_OUTPUT_CHARS = 80_000

_PENDING_INSTALL_PACKAGES = 'install_packages'
_PENDING_REMOVE_PACKAGES = 'remove_packages'
_PENDING_INSTALL_PROJECT = 'install_project'
_PENDING_RUN_SCRIPT = 'run_script'

__all__ = [
    'INSTALL_NPM_PACKAGES_NAME',
    'NPM_INSTALL_PROJECT_NAME',
    'REMOVE_NPM_PACKAGES_NAME',
    'RUN_NPM_SCRIPT_NAME',
    'execute_pending_node_dependency_request',
    'install_npm_packages_tool',
    'node_dependency_tools',
    'npm_install_project_tool',
    'remove_npm_packages_tool',
    'run_npm_script_tool',
]


def _active_session_or_error() -> tuple[str | None, SessionState | None, str | None]:
    sid = (current_session_id.get() or '').strip()
    if not sid:
        return None, None, 'Tool error: no active session.'
    blocked = mutation_tools_blocked_reason(sid)
    if blocked:
        return sid, None, blocked
    return sid, get_session(sid), None


def _workspace_root(session: SessionState) -> tuple[Path | None, str]:
    raw = (session.workspace_path or '').strip()
    if not raw:
        return None, 'Tool error: no workspace is open for this session.'
    root = Path(raw).resolve()
    if not root.is_dir():
        return None, f'Tool error: workspace path is not a directory: `{raw}`.'
    return root, raw


def _resolve_project_dir(workspace_root: Path, relative_project_dir: str) -> tuple[Path | None, str | None, str]:
    """Return (absolute project dir, error or None, posix label for messages)."""
    cleaned = (relative_project_dir or '').strip().replace('\\', '/').strip('/')
    if not cleaned:
        target = workspace_root.resolve()
        return target, None, '.'
    candidate = (workspace_root / cleaned).resolve()
    try:
        candidate.relative_to(workspace_root.resolve())
    except ValueError:
        return None, 'Tool error: project directory must stay inside the workspace.', ''
    if not candidate.is_dir():
        return None, f'Tool error: project directory does not exist: `{cleaned}`.', ''
    return candidate, None, cleaned


def detect_package_manager(project_dir: Path) -> str:
    """Return ``npm``, ``pnpm``, or ``yarn`` based on lockfiles (``package.json`` directory)."""

    if (project_dir / 'pnpm-lock.yaml').is_file():
        return 'pnpm'
    if (project_dir / 'yarn.lock').is_file():
        return 'yarn'
    return 'npm'


def _pm_executable(pm: str) -> str | None:
    return shutil.which(pm)


def _require_package_json(project_dir: Path) -> str | None:
    if not (project_dir / 'package.json').is_file():
        return (
            f'Tool error: no `package.json` in `{project_dir}`—not a Node project root. '
            'Set `relative_project_dir` to the folder that contains `package.json`.'
        )
    return None


def _validate_pkg_token(name: str) -> bool:
    s = str(name or '').strip()
    if not s or len(s) > 512:
        return False
    return bool(re.match(r'^[A-Za-z0-9@._\-/]+$', s))


def _validate_script_name(name: str) -> bool:
    s = str(name or '').strip()
    if not s or len(s) > 128:
        return False
    return bool(re.match(r'^[A-Za-z0-9][A-Za-z0-9._-]*$', s))


def _package_json_script_gate(project_dir: Path, script_name: str) -> str | None:
    """If ``package.json`` has a non-empty ``scripts`` object, require ``script_name`` to be a key."""

    path = project_dir / 'package.json'
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return None
    scripts = data.get('scripts')
    if not isinstance(scripts, dict) or not scripts:
        return None
    if script_name not in scripts:
        keys = sorted(scripts.keys())
        preview = ', '.join(f'`{k}`' for k in keys[:24])
        suffix = ' …' if len(keys) > 24 else ''
        return (
            f'Tool error: script `{script_name}` is not listed under package.json "scripts". '
            f'Available: {preview}{suffix}'
        )
    return None


def _format_summary(
    *,
    title: str,
    workspace_label: str,
    project_label: str,
    pm: str,
    command_text: str,
    details: str = '',
) -> str:
    body = (
        f'{title}:\n'
        f'- Workspace: `{workspace_label}`\n'
        f'- Project: `{project_label}`\n'
        f'- Package manager: `{pm}`\n'
        f'- Command: `{command_text}`\n'
    )
    if details.strip():
        body += f'\n{details.strip()}'
    if len(body) <= _MAX_OUTPUT_CHARS:
        return body
    return truncate_text_head_tail(body, _MAX_OUTPUT_CHARS)


def _npm_run_script_timeout_sec() -> float | None:
    """Wall clock for package.json scripts; ``None`` uses ``CLARA_SUBPROCESS_TIMEOUT_SEC`` only."""

    if CLARA_NPM_SCRIPT_TIMEOUT_SEC > 0:
        return float(CLARA_NPM_SCRIPT_TIMEOUT_SEC)
    return None


async def _run_pm(
    *,
    args: list[str],
    cwd: Path,
    title: str,
    workspace_label: str,
    project_label: str,
    pm: str,
    subprocess_timeout_sec: float | None = None,
) -> str:
    command_text = ' '.join(args)
    code, output = await _run_subprocess_with_output(args, cwd=cwd, timeout_sec=subprocess_timeout_sec)
    detail = output.strip() or f'(exit code {code})'
    ok = code == 0
    summary = _format_summary(
        title=title,
        workspace_label=workspace_label,
        project_label=project_label,
        pm=pm,
        command_text=command_text,
        details=detail,
    )
    if not ok:
        err_body = f'Tool error: command failed.\n\n{summary}'
        if len(err_body) <= _MAX_OUTPUT_CHARS:
            return err_body
        return truncate_text_head_tail(err_body, _MAX_OUTPUT_CHARS)
    return summary


def _pending_node_command(
    session: SessionState,
    *,
    title: str,
    message: str,
    confirm_label: str,
    command_text: str,
    details: list[str],
    action: dict[str, Any],
) -> str:
    session.pending_accept_command_request = {
        'request_id': uuid.uuid4().hex,
        'kind': ACCEPT_COMMAND_KIND_NODE_DEPENDENCY,
        'title': title,
        'message': message,
        'confirm_label': confirm_label,
        'cancel_label': 'Cancel',
        'command_text': command_text,
        'details': details,
        'cancel_note': f'User cancelled the pending Node/npm action: {title}.',
        'action': action,
    }
    return (
        f'Pending user confirmation for Node/npm action `{title}`. '
        'The UI will ask the user to confirm before the command runs.'
    )


async def execute_pending_node_dependency_request(session: SessionState, pending: dict) -> str:
    """Run a previously staged Node dependency action after the user accepts it."""

    action = pending.get('action') if isinstance(pending.get('action'), dict) else {}
    kind = str(action.get('kind') or '')
    workspace_root, ws_label = _workspace_root(session)
    if workspace_root is None:
        return ws_label
    rel = str(action.get('project_dir') or '').strip().replace('\\', '/')
    project_dir, err, proj_label = _resolve_project_dir(workspace_root, rel)
    if err:
        return err
    assert project_dir is not None
    pj = _require_package_json(project_dir)
    if pj:
        return pj
    pm = detect_package_manager(project_dir)
    exe = _pm_executable(pm)
    if not exe:
        return f'Tool error: `{pm}` is not on PATH; install Node.js and the package manager.'

    if kind == _PENDING_INSTALL_PACKAGES:
        packages = [str(x) for x in (action.get('packages') or []) if str(x).strip()]
        if not packages:
            return 'Tool error: no packages in pending action.'
        dev = bool(action.get('dev'))
        args = _build_add_args(pm, exe, packages, dev=dev)
        return await _run_pm(
            args=args,
            cwd=project_dir,
            title='Node/npm package install summary',
            workspace_label=ws_label,
            project_label=proj_label,
            pm=pm,
        )
    if kind == _PENDING_REMOVE_PACKAGES:
        packages = [str(x) for x in (action.get('packages') or []) if str(x).strip()]
        if not packages:
            return 'Tool error: no packages in pending action.'
        args = _build_remove_args(pm, exe, packages)
        return await _run_pm(
            args=args,
            cwd=project_dir,
            title='Node/npm package removal summary',
            workspace_label=ws_label,
            project_label=proj_label,
            pm=pm,
        )
    if kind == _PENDING_INSTALL_PROJECT:
        args = _build_install_project_args(pm, exe)
        return await _run_pm(
            args=args,
            cwd=project_dir,
            title='Node/npm project install summary',
            workspace_label=ws_label,
            project_label=proj_label,
            pm=pm,
        )
    if kind == _PENDING_RUN_SCRIPT:
        script = str(action.get('script_name') or '').strip()
        if not _validate_script_name(script):
            return 'Tool error: invalid script name in pending action.'
        args = _build_run_script_args(pm, exe, script)
        return await _run_pm(
            args=args,
            cwd=project_dir,
            title='npm script summary',
            workspace_label=ws_label,
            project_label=proj_label,
            pm=pm,
            subprocess_timeout_sec=_npm_run_script_timeout_sec(),
        )
    return f'Tool error: unsupported pending Node dependency action `{kind or "unknown"}`.'


def _build_add_args(pm: str, exe: str, packages: list[str], *, dev: bool) -> list[str]:
    if pm == 'npm':
        out = [exe, 'install', *packages]
        if dev:
            out.append('--save-dev')
        return out
    if pm == 'pnpm':
        out = [exe, 'add', *packages]
        if dev:
            out.append('--save-dev')
        return out
    out = [exe, 'add', *packages]
    if dev:
        out.append('--dev')
    return out


def _build_remove_args(pm: str, exe: str, packages: list[str]) -> list[str]:
    if pm == 'npm':
        return [exe, 'uninstall', *packages]
    if pm == 'pnpm':
        return [exe, 'remove', *packages]
    return [exe, 'remove', *packages]


def _build_install_project_args(pm: str, exe: str) -> list[str]:
    if pm == 'npm':
        return [exe, 'install']
    if pm == 'pnpm':
        return [exe, 'install']
    return [exe, 'install']


def _build_run_script_args(pm: str, exe: str, script: str) -> list[str]:
    if pm == 'npm':
        return [exe, 'run', script]
    if pm == 'pnpm':
        return [exe, 'run', script]
    return [exe, 'run', script]


@tool(INSTALL_NPM_PACKAGES_NAME, description=describe('Install npm packages into a Node project.',
        when='adding runtime or dev dependencies to a `package.json` root.',
        not_='Python pip installs.',
        shape='uses npm, pnpm, or yarn by lockfile detection; `dev=true` for devDependencies; HITL confirm when auto-apply off.',))
async def install_npm_packages_tool(
    packages: Annotated[list[str], 'package names (may include version specifiers)'],
    dev: bool = False,
    relative_project_dir: Annotated[str, 'workspace-relative POSIX project dir; empty = auto-detect'] = '',
) -> str:

    _sid, session, error = _active_session_or_error()
    if error:
        return error
    assert session is not None
    names = [str(p).strip() for p in (packages or []) if str(p).strip()]
    if not names:
        return 'Tool error: at least one package name is required.'
    for n in names:
        if not _validate_pkg_token(n):
            return f'Tool error: unsupported package name `{n}`.'

    workspace_root, ws_label = _workspace_root(session)
    if workspace_root is None:
        return ws_label
    project_dir, err, proj_label = _resolve_project_dir(workspace_root, relative_project_dir)
    if err:
        return err
    assert project_dir is not None
    pj = _require_package_json(project_dir)
    if pj:
        return pj
    pm = detect_package_manager(project_dir)
    exe = _pm_executable(pm)
    if not exe:
        return f'Tool error: `{pm}` is not on PATH; install Node.js and the package manager.'
    args = _build_add_args(pm, exe, names, dev=dev)
    command_text = ' '.join(args)

    if session.auto_apply_mode:
        return await _run_pm(
            args=args,
            cwd=project_dir,
            title='Node/npm package install summary',
            workspace_label=ws_label,
            project_label=proj_label,
            pm=pm,
        )
    return _pending_node_command(
        session,
        title='Install npm packages',
        message='Install package(s) into the Node project.',
        confirm_label='Install packages',
        command_text=command_text,
        details=[
            f'Workspace: `{ws_label}`',
            f'Project: `{proj_label}`',
            f'Package manager: `{pm}`',
            f'Packages: {", ".join(f"`{item}`" for item in names)}',
            f'Dev dependency: {dev}',
        ],
        action={
            'kind': _PENDING_INSTALL_PACKAGES,
            'project_dir': relative_project_dir.strip().replace('\\', '/'),
            'packages': names,
            'dev': dev,
        },
    )


@tool(REMOVE_NPM_PACKAGES_NAME, description=describe('Remove packages from a Node project.',
        when='uninstalling unused or conflicting npm dependencies.',
        not_='Python pip uninstall.',
        shape='npm uninstall / pnpm remove / yarn remove by lockfile detection; HITL confirm when auto-apply off.',))
async def remove_npm_packages_tool(
    packages: Annotated[list[str], 'package names (may include version specifiers)'],
    relative_project_dir: Annotated[str, 'workspace-relative POSIX project dir; empty = auto-detect'] = '',
) -> str:

    _sid, session, error = _active_session_or_error()
    if error:
        return error
    assert session is not None
    names = [str(p).strip() for p in (packages or []) if str(p).strip()]
    if not names:
        return 'Tool error: at least one package name is required.'
    for n in names:
        if not _validate_pkg_token(n):
            return f'Tool error: unsupported package name `{n}`.'

    workspace_root, ws_label = _workspace_root(session)
    if workspace_root is None:
        return ws_label
    project_dir, err, proj_label = _resolve_project_dir(workspace_root, relative_project_dir)
    if err:
        return err
    assert project_dir is not None
    pj = _require_package_json(project_dir)
    if pj:
        return pj
    pm = detect_package_manager(project_dir)
    exe = _pm_executable(pm)
    if not exe:
        return f'Tool error: `{pm}` is not on PATH; install Node.js and the package manager.'
    args = _build_remove_args(pm, exe, names)
    command_text = ' '.join(args)

    if session.auto_apply_mode:
        return await _run_pm(
            args=args,
            cwd=project_dir,
            title='Node/npm package removal summary',
            workspace_label=ws_label,
            project_label=proj_label,
            pm=pm,
        )
    return _pending_node_command(
        session,
        title='Remove npm packages',
        message='Remove package(s) from the Node project.',
        confirm_label='Remove packages',
        command_text=command_text,
        details=[
            f'Workspace: `{ws_label}`',
            f'Project: `{proj_label}`',
            f'Package manager: `{pm}`',
            f'Packages: {", ".join(f"`{item}`" for item in names)}',
        ],
        action={
            'kind': _PENDING_REMOVE_PACKAGES,
            'project_dir': relative_project_dir.strip().replace('\\', '/'),
            'packages': names,
        },
    )


@tool(NPM_INSTALL_PROJECT_NAME, description=describe('Run install for the whole Node project.',
        when='syncing `node_modules` from lockfile/manifest after clone or manifest change.',
        not_='adding individual packages (use `install_npm_packages`).',
        shape='`npm install`, `pnpm install`, or `yarn install` by lockfile detection; HITL confirm when auto-apply off.',))
async def npm_install_project_tool(
    relative_project_dir: Annotated[str, 'workspace-relative POSIX project dir; empty = auto-detect'] = '',
) -> str:

    _sid, session, error = _active_session_or_error()
    if error:
        return error
    assert session is not None
    workspace_root, ws_label = _workspace_root(session)
    if workspace_root is None:
        return ws_label
    project_dir, err, proj_label = _resolve_project_dir(workspace_root, relative_project_dir)
    if err:
        return err
    assert project_dir is not None
    pj = _require_package_json(project_dir)
    if pj:
        return pj
    pm = detect_package_manager(project_dir)
    exe = _pm_executable(pm)
    if not exe:
        return f'Tool error: `{pm}` is not on PATH; install Node.js and the package manager.'
    args = _build_install_project_args(pm, exe)
    command_text = ' '.join(args)

    if session.auto_apply_mode:
        return await _run_pm(
            args=args,
            cwd=project_dir,
            title='Node/npm project install summary',
            workspace_label=ws_label,
            project_label=proj_label,
            pm=pm,
        )
    return _pending_node_command(
        session,
        title='Install Node project dependencies',
        message='Install all dependencies from the lockfile/manifest.',
        confirm_label='Run install',
        command_text=command_text,
        details=[
            f'Workspace: `{ws_label}`',
            f'Project: `{proj_label}`',
            f'Package manager: `{pm}`',
        ],
        action={
            'kind': _PENDING_INSTALL_PROJECT,
            'project_dir': relative_project_dir.strip().replace('\\', '/'),
        },
    )


@tool(RUN_NPM_SCRIPT_NAME, description=describe('Run a package.json script.',
        when='running build, test, lint, or other declared npm scripts.',
        not_='long-lived dev servers (prefer `run_command` so they use the background-command framework).',
        shape='`npm run <name>`, `pnpm run`, or `yarn run` by lockfile detection; HITL confirm when auto-apply off.',))
async def run_npm_script_tool(
    script_name: str,
    relative_project_dir: Annotated[str, 'workspace-relative POSIX project dir; empty = auto-detect'] = '',
) -> str:

    _sid, session, error = _active_session_or_error()
    if error:
        return error
    assert session is not None
    if not _validate_script_name(script_name):
        return 'Tool error: `script_name` must be a non-empty identifier (letters, numbers, ._-).'

    workspace_root, ws_label = _workspace_root(session)
    if workspace_root is None:
        return ws_label
    project_dir, err, proj_label = _resolve_project_dir(workspace_root, relative_project_dir)
    if err:
        return err
    assert project_dir is not None
    pj = _require_package_json(project_dir)
    if pj:
        return pj
    sn = script_name.strip()
    gate = _package_json_script_gate(project_dir, sn)
    if gate:
        return gate
    pm = detect_package_manager(project_dir)
    exe = _pm_executable(pm)
    if not exe:
        return f'Tool error: `{pm}` is not on PATH; install Node.js and the package manager.'
    args = _build_run_script_args(pm, exe, sn)
    command_text = ' '.join(args)

    if session.auto_apply_mode:
        return await _run_pm(
            args=args,
            cwd=project_dir,
            title='npm script summary',
            workspace_label=ws_label,
            project_label=proj_label,
            pm=pm,
            subprocess_timeout_sec=_npm_run_script_timeout_sec(),
        )
    return _pending_node_command(
        session,
        title=f'Run npm script `{script_name}`',
        message='Run the script from package.json.',
        confirm_label='Run script',
        command_text=command_text,
        details=[
            f'Workspace: `{ws_label}`',
            f'Project: `{proj_label}`',
            f'Package manager: `{pm}`',
            f'Script: `{script_name}`',
        ],
        action={
            'kind': _PENDING_RUN_SCRIPT,
            'project_dir': relative_project_dir.strip().replace('\\', '/'),
            'script_name': sn,
        },
    )


def node_dependency_tools() -> tuple[list[object], dict[str, object]]:
    from clara_coder_backend.tools.node_discovery import discover_npm_projects_tool
    from clara_coder_backend.tools.npm_search import search_npm_packages_tool

    tools: list[object] = [
        discover_npm_projects_tool,
        search_npm_packages_tool,
        install_npm_packages_tool,
        remove_npm_packages_tool,
        npm_install_project_tool,
        run_npm_script_tool,
    ]
    return tools, {t.name: t for t in tools}
