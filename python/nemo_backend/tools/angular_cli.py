"""Run Angular CLI (`ng`) using only the local project ``node_modules/.bin`` binary."""

from __future__ import annotations

import re
import sys
import uuid
from pathlib import Path
from typing import Any

from langchain_core.tools import tool

from nemo_backend.accept_command import ACCEPT_COMMAND_KIND_ANGULAR_CLI
from nemo_backend.domain import SessionState
from nemo_backend.config import NEMO_NPM_SCRIPT_TIMEOUT_SEC
from nemo_backend.tools.node_deps import (
    _active_session_or_error,
    _require_package_json,
    _resolve_project_dir,
    _workspace_root,
)
from nemo_backend.python_env import _run_subprocess_with_output
from nemo_backend.tools.workspace import truncate_text_head_tail
from nemo_backend.state import current_session_id

ANGULAR_CLI_TOOL_NAME = 'angular_cli_tool'
_MAX_OUTPUT_CHARS = 80_000
_MAX_NG_ARGS = 64
_MAX_ARG_LEN = 512
_PENDING_ANGULAR_CLI_RUN = 'angular_cli_run'

_ARG_TOKEN_RE = re.compile(r'^[A-Za-z0-9@._/:+=,\-]+$')
_FORBIDDEN_SUBPROCESS_CHARS = frozenset(";|&$`\n\r<>()`")

# These never finish under our captured subprocess (stdin/stdout pipes); they look like a hung agent until timeout.
_NG_NON_TERMINATING_FIRST = frozenset({'serve'})


def _ng_args_imply_endless_process(ng_args: list[str]) -> str | None:
    """Return an error if ``ng`` would run until killed (serve / watch / run …:serve)."""

    if not ng_args:
        return None
    head = ng_args[0]
    if head in _NG_NON_TERMINATING_FIRST:
        return (
            f'Tool error: `ng {head}` does not exit (dev server). The agent would block until timeout. '
            'Use `ng build` or another finite command, or run the dev server from the app terminal outside the agent.'
        )
    if head == 'run' and any(':serve' in part for part in ng_args[1:]):
        return (
            'Tool error: `ng run …:serve` does not exit (dev-server target). '
            'Use `ng build` or run serve manually in a terminal.'
        )
    for a in ng_args:
        if a == '--watch':
            return (
                'Tool error: `ng` was invoked with `--watch`, which does not exit. '
                'Omit watch mode or use a finite command (e.g. `ng build` without `--watch`).'
            )
        if a.startswith('--watch='):
            val = a.split('=', 1)[1].strip().lower()
            if val not in ('false', '0', 'no'):
                return (
                    'Tool error: `ng` watch mode (`--watch=…`) does not exit unless set to false. '
                    'Use `--watch=false` for one-shot builds or pick a command without watch.'
                )
    return None


def _npm_script_timeout_sec() -> float | None:
    if NEMO_NPM_SCRIPT_TIMEOUT_SEC > 0:
        return float(NEMO_NPM_SCRIPT_TIMEOUT_SEC)
    return None


def resolve_local_ng_executable(project_dir: Path) -> Path | None:
    """Return ``node_modules/.bin/ng`` (or ``ng.cmd`` / ``ng.ps1`` on Windows) if it exists as a file."""

    bindir = project_dir / 'node_modules' / '.bin'
    if sys.platform.startswith('win'):
        for name in ('ng.cmd', 'ng', 'ng.ps1'):
            candidate = bindir / name
            if candidate.is_file():
                return candidate
        return None
    candidate = bindir / 'ng'
    if candidate.is_file():
        return candidate
    return None


def _missing_local_ng_message(project_dir: Path) -> str:
    return (
        'Tool error: local Angular CLI not found at `node_modules/.bin/ng` for this project. '
        'Install dependencies with `npm_install_project` (same `relative_project_dir`) and ensure `@angular/cli` '
        f'is listed in that project’s `package.json`, then retry. Project: `{project_dir}`.'
    )


def validate_ng_args(ng_args: object) -> tuple[list[str] | None, str | None]:
    """Return (cleaned argv tail after ``ng``,) or (None, error message)."""

    if not isinstance(ng_args, list):
        return None, 'Tool error: `ng_args` must be a list of strings.'
    if not ng_args:
        return None, 'Tool error: `ng_args` must be non-empty (e.g. `["version"]` or `["build","--configuration=production"]`).'
    if len(ng_args) > _MAX_NG_ARGS:
        return None, f'Tool error: at most {_MAX_NG_ARGS} `ng_args` entries are allowed.'
    out: list[str] = []
    for i, raw in enumerate(ng_args):
        if not isinstance(raw, str):
            return None, f'Tool error: `ng_args[{i}]` must be a string.'
        s = raw.strip()
        if not s:
            return None, f'Tool error: `ng_args[{i}]` is empty.'
        if len(s) > _MAX_ARG_LEN:
            return None, f'Tool error: `ng_args[{i}]` exceeds {_MAX_ARG_LEN} characters.'
        if '..' in s.split('/'):
            return None, f'Tool error: `ng_args[{i}]` must not contain `..` path segments.'
        if any(ch in s for ch in _FORBIDDEN_SUBPROCESS_CHARS):
            return None, f'Tool error: `ng_args[{i}]` contains disallowed characters.'
        if '\t' in s:
            return None, f'Tool error: `ng_args[{i}]` contains tabs.'
        if not _ARG_TOKEN_RE.match(s):
            return None, f'Tool error: `ng_args[{i}]` has unsupported characters (use alphanumeric and `@._/:+=,-` only).'
        out.append(s)
    endless = _ng_args_imply_endless_process(out)
    if endless:
        return None, endless
    return out, None


def _format_angular_summary(
    *,
    title: str,
    workspace_label: str,
    project_label: str,
    command_text: str,
    details: str = '',
) -> str:
    body = (
        f'{title}:\n'
        f'- Workspace: `{workspace_label}`\n'
        f'- Project: `{project_label}`\n'
        f'- Angular CLI: local `node_modules/.bin/ng`\n'
        f'- Command: `{command_text}`\n'
    )
    if details.strip():
        body += f'\n{details.strip()}'
    if len(body) <= _MAX_OUTPUT_CHARS:
        return body
    return truncate_text_head_tail(body, _MAX_OUTPUT_CHARS)


async def _run_angular(
    *,
    args: list[str],
    cwd: Path,
    title: str,
    workspace_label: str,
    project_label: str,
    subprocess_timeout_sec: float | None = None,
) -> str:
    command_text = ' '.join(args)
    code, output = await _run_subprocess_with_output(args, cwd=cwd, timeout_sec=subprocess_timeout_sec)
    detail = output.strip() or f'(exit code {code})'
    ok = code == 0
    summary = _format_angular_summary(
        title=title,
        workspace_label=workspace_label,
        project_label=project_label,
        command_text=command_text,
        details=detail,
    )
    if not ok:
        err_body = f'Tool error: command failed.\n\n{summary}'
        if len(err_body) <= _MAX_OUTPUT_CHARS:
            return err_body
        return truncate_text_head_tail(err_body, _MAX_OUTPUT_CHARS)
    return summary


def _pending_angular_command(
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
        'kind': ACCEPT_COMMAND_KIND_ANGULAR_CLI,
        'title': title,
        'message': message,
        'confirm_label': confirm_label,
        'cancel_label': 'Cancel',
        'command_text': command_text,
        'details': details,
        'cancel_note': f'User cancelled the pending Angular CLI action: {title}.',
        'action': action,
    }
    return (
        f'Pending user confirmation for Angular CLI action `{title}`. '
        'The UI will ask the user to confirm before the command runs.'
    )


async def execute_pending_angular_cli_request(session: SessionState, pending: dict) -> str:
    """Run a previously staged Angular CLI action after the user accepts it."""

    action = pending.get('action') if isinstance(pending.get('action'), dict) else {}
    kind = str(action.get('kind') or '')
    if kind != _PENDING_ANGULAR_CLI_RUN:
        return f'Tool error: unsupported pending Angular CLI action `{kind or "unknown"}`.'
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
    ng_exe = resolve_local_ng_executable(project_dir)
    if ng_exe is None:
        return _missing_local_ng_message(project_dir)
    ng_args, verr = validate_ng_args(action.get('ng_args'))
    if verr:
        return verr
    assert ng_args is not None
    args = [str(ng_exe), *ng_args]
    return await _run_angular(
        args=args,
        cwd=project_dir,
        title='Angular CLI summary',
        workspace_label=ws_label,
        project_label=proj_label,
        subprocess_timeout_sec=_npm_script_timeout_sec(),
    )


@tool(ANGULAR_CLI_TOOL_NAME)
async def angular_cli_tool(ng_args: list[str], relative_project_dir: str = '') -> str:
    """Run the Angular CLI using **only** the project-local ``node_modules/.bin/ng`` (no global ``ng``).

    Requires ``package.json`` at the resolved project directory and a successful local install that provides
    ``@angular/cli`` (so ``node_modules/.bin/ng`` exists). Run ``npm_install_project`` for that directory first if needed.

    Pass ``ng_args`` as the arguments **after** ``ng`` (e.g. ``["version"]``, ``["build","--configuration=production"]``).
    Do **not** use ``serve``, ``run …:serve``, or watch mode (``--watch`` unless ``--watch=false``)—those never exit and will stall the agent.
    Use ``relative_project_dir`` when the app lives under a subfolder (same rules as npm tools).
    """

    _sid, session, error = _active_session_or_error()
    if error:
        return error
    assert session is not None
    ng_args_clean, verr = validate_ng_args(ng_args)
    if verr:
        return verr
    assert ng_args_clean is not None

    workspace_root, ws_label = _workspace_root(session)
    if workspace_root is None:
        return ws_label
    project_dir, perr, proj_label = _resolve_project_dir(workspace_root, relative_project_dir)
    if perr:
        return perr
    assert project_dir is not None
    pj = _require_package_json(project_dir)
    if pj:
        return pj
    ng_exe = resolve_local_ng_executable(project_dir)
    if ng_exe is None:
        return _missing_local_ng_message(project_dir)

    args = [str(ng_exe), *ng_args_clean]
    command_text = ' '.join(args)
    if session.auto_apply_mode:
        return await _run_angular(
            args=args,
            cwd=project_dir,
            title='Angular CLI summary',
            workspace_label=ws_label,
            project_label=proj_label,
            subprocess_timeout_sec=_npm_script_timeout_sec(),
        )
    return _pending_angular_command(
        session,
        title='Run Angular CLI',
        message='Run the local Angular CLI (`ng`) in the Node project.',
        confirm_label='Run Angular CLI',
        command_text=command_text,
        details=[
            f'Workspace: `{ws_label}`',
            f'Project: `{proj_label}`',
            f'Local CLI: `{ng_exe}`',
            f'Args: {", ".join(f"`{a}`" for a in ng_args_clean)}',
        ],
        action={
            'kind': _PENDING_ANGULAR_CLI_RUN,
            'project_dir': relative_project_dir.strip().replace('\\', '/'),
            'ng_args': list(ng_args_clean),
        },
    )


__all__ = [
    'ANGULAR_CLI_TOOL_NAME',
    'angular_cli_tool',
    'execute_pending_angular_cli_request',
    'resolve_local_ng_executable',
    'validate_ng_args',
]
