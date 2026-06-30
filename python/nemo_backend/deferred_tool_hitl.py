"""Defer workspace execute tools until the user confirms via the accept-command HITL card."""

from __future__ import annotations

import json
import uuid
from contextvars import ContextVar
from typing import Any

from nemo_backend.accept_command import ACCEPT_COMMAND_KIND_DEFERRED_TOOL
from nemo_backend.domain import SessionState
from nemo_backend.state import current_session_id, sessions

deferred_tool_hitl_bypass: ContextVar[bool] = ContextVar('deferred_tool_hitl_bypass', default=False)

DEFERRED_HITL_TOOL_NAMES: frozenset[str] = frozenset(
    {
        'ensure_python_workspace_env',
        'bootstrap_python_testing_dependencies',
        'run_staging_overlay_command',
        'run_workspace_pytest_tests',
        'run_workspace_python_smoke_test',
        'run_workspace_node_smoke_test',
    }
)

__all__ = [
    'DEFERRED_HITL_TOOL_NAMES',
    'deferred_tool_hitl_bypass',
    'execute_pending_deferred_tool',
    'maybe_await_hitl_for_deferred_tool',
]


def _presentation(tool_name: str, tool_input: dict[str, Any]) -> tuple[str, str, str, list[str]]:
    if tool_name == 'ensure_python_workspace_env':
        return (
            'Initialize workspace Python environment',
            'Create or reuse the workspace `.venv`, activate it for this session, and install bootstrap dependencies.',
            'python -m venv .venv && pip install (bootstrap)',
            [],
        )
    if tool_name == 'bootstrap_python_testing_dependencies':
        return (
            'Bootstrap Python testing dependencies',
            'Install workspace requirements, testing helpers, and Python LSP packages into the active `.venv`.',
            'pip install -r requirements.txt (and testing helpers)',
            [],
        )
    if tool_name == 'run_workspace_pytest_tests':
        return (
            'Run workspace pytest',
            'Run `pytest` in the workspace virtual environment.',
            'python -m pytest tests -v',
            [],
        )
    if tool_name == 'run_workspace_python_smoke_test':
        rel = str(tool_input.get('relative_path') or '').strip()
        cmd = f'python {rel}' if rel else 'python <entrypoint>'
        details = [f'Entry script: `{rel}`'] if rel else []
        return (
            'Run workspace Python smoke test',
            'Run a short-lived Python entry script in the workspace environment.',
            cmd,
            details,
        )
    if tool_name == 'run_workspace_node_smoke_test':
        rel = str(tool_input.get('relative_project_dir') or '').strip()
        script = str(tool_input.get('script_name') or '').strip()
        details: list[str] = []
        if rel:
            details.append(f'Project dir: `{rel}`')
        if script:
            details.append(f'Script: `{script}`')
        cmd = 'npm run ' + (script or '<smoke|dev|start|serve|preview>')
        return (
            'Run workspace Node smoke test',
            'Run an npm/pnpm/yarn script in the selected Node project.',
            cmd,
            details,
        )
    if tool_name == 'run_staging_overlay_command':
        argv_json = str(tool_input.get('command_argv_json') or '[]')
        cwd = str(tool_input.get('cwd_relative') or '').strip()
        try:
            argv = json.loads(argv_json)
            rendered = ' '.join(str(a) for a in argv) if isinstance(argv, list) else argv_json
        except json.JSONDecodeError:
            rendered = argv_json
        details = []
        if cwd:
            details.append(f'Working directory: `{cwd}`')
        return (
            'Run staging overlay command',
            'Execute a command in the staging overlay (workspace + pending drafts) or workspace when in direct mode.',
            rendered,
            details,
        )
    return (
        'Run tool',
        f'Execute `{tool_name}` in the active workspace.',
        tool_name,
        [],
    )


def maybe_await_hitl_for_deferred_tool(
    session: SessionState,
    *,
    tool_name: str,
    tool_input: dict[str, Any] | None = None,
) -> str | None:
    """Stage accept-command HITL and return the pending tool message, or None to run immediately."""

    if tool_name not in DEFERRED_HITL_TOOL_NAMES:
        return None
    if session.auto_apply_mode or deferred_tool_hitl_bypass.get():
        return None
    inp = dict(tool_input or {})
    title, message, command_text, details = _presentation(tool_name, inp)
    session.pending_accept_command_request = {
        'request_id': uuid.uuid4().hex,
        'kind': ACCEPT_COMMAND_KIND_DEFERRED_TOOL,
        'title': title,
        'message': message,
        'confirm_label': 'Run',
        'cancel_label': 'Cancel',
        'command_text': command_text,
        'details': details,
        'cancel_note': f'User cancelled the pending command: {title}.',
        'action': {
            'tool_name': tool_name,
            'tool_input': inp,
        },
    }
    return (
        f'Pending user confirmation for `{tool_name}`. '
        'The UI will ask the user to confirm before this command runs.'
    )


def _session_id_for(session: SessionState) -> str:
    for sid, state in sessions.items():
        if state is session:
            return sid
    return ''


async def execute_pending_deferred_tool(session: SessionState, pending: dict[str, Any]) -> str:
    """Run a deferred tool after the user accepts the accept-command card."""

    action = pending.get('action') if isinstance(pending.get('action'), dict) else {}
    tool_name = str(action.get('tool_name') or '')
    tool_input = action.get('tool_input') if isinstance(action.get('tool_input'), dict) else {}
    tool = _resolve_deferred_tool(tool_name)
    if tool is None:
        return f'Command confirmation failed: unsupported deferred tool `{tool_name or "unknown"}`.'
    sid = _session_id_for(session)
    sid_token = current_session_id.set(sid) if sid else None
    hitl_token = deferred_tool_hitl_bypass.set(True)
    try:
        result = await tool.ainvoke(tool_input)
        return str(result)
    finally:
        deferred_tool_hitl_bypass.reset(hitl_token)
        if sid_token is not None:
            current_session_id.reset(sid_token)


def _resolve_deferred_tool(tool_name: str) -> Any | None:
    if tool_name == 'ensure_python_workspace_env':
        from nemo_backend.tools.python_env import ensure_python_workspace_env_tool

        return ensure_python_workspace_env_tool
    if tool_name == 'bootstrap_python_testing_dependencies':
        from nemo_backend.tools.python_deps import bootstrap_python_testing_dependencies_tool

        return bootstrap_python_testing_dependencies_tool
    if tool_name == 'run_staging_overlay_command':
        from nemo_backend.tools.review_tools import run_staging_overlay_command

        return run_staging_overlay_command
    if tool_name == 'run_workspace_pytest_tests':
        from nemo_backend.tools.project_review_tools import run_workspace_pytest_tests

        return run_workspace_pytest_tests
    if tool_name == 'run_workspace_python_smoke_test':
        from nemo_backend.tools.project_review_tools import run_workspace_python_smoke_test

        return run_workspace_python_smoke_test
    if tool_name == 'run_workspace_node_smoke_test':
        from nemo_backend.tools.project_review_tools import run_workspace_node_smoke_test

        return run_workspace_node_smoke_test
    return None
