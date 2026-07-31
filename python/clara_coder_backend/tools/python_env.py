"""General-purpose tools for initializing and activating a workspace Python environment."""

from __future__ import annotations

from langchain_core.tools import tool

from clara_coder_backend.hitl.deferred_tool_hitl import maybe_await_hitl_for_deferred_tool
from clara_coder_backend.runtime.python_env import ensure_session_python_workspace_env
from clara_coder_backend.session.state import current_session_id, get_session
from clara_coder_backend.tools.tool_conventions import describe

ENSURE_PYTHON_WORKSPACE_ENV_NAME = 'ensure_python_workspace_env'

__all__ = ['ENSURE_PYTHON_WORKSPACE_ENV_NAME', 'ensure_python_workspace_env_tool']


@tool(ENSURE_PYTHON_WORKSPACE_ENV_NAME, description=describe(
    'Create or reuse workspace `.venv`, install deps, activate session env.',
    when='before LSP or Python tooling when the workspace needs a venv.',
    not_='Node/npm setup (use `discover_npm_projects` + `npm_install_project`).',
    shape='idempotent when the environment is already healthy.',
))
async def ensure_python_workspace_env_tool() -> str:

    sid = (current_session_id.get() or '').strip()
    if not sid:
        return 'Tool error: no active session.'
    session = get_session(sid)
    pending = maybe_await_hitl_for_deferred_tool(session, tool_name=ENSURE_PYTHON_WORKSPACE_ENV_NAME, tool_input={})
    if pending:
        return pending
    result = await ensure_session_python_workspace_env(
        session,
        allow_workspace_root_fallback=True,
        bootstrap_dependencies=True,
    )
    if result is None:
        return 'Tool error: no workspace is attached to this session.'
    return result.summary
