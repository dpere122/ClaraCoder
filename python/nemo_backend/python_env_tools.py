"""General-purpose tools for initializing and activating a workspace Python environment."""

from __future__ import annotations

from langchain_core.tools import tool

from nemo_backend.python_env import ensure_session_python_workspace_env
from nemo_backend.state import current_session_id, get_session

ENSURE_PYTHON_WORKSPACE_ENV_NAME = 'ensure_python_workspace_env'

__all__ = ['ENSURE_PYTHON_WORKSPACE_ENV_NAME', 'ensure_python_workspace_env_tool']


@tool(ENSURE_PYTHON_WORKSPACE_ENV_NAME)
async def ensure_python_workspace_env_tool() -> str:
    """Use before relying on LSP or Python tooling when the workspace needs a venv: creates or reuses `.venv`, installs deps, activates session env.

    Idempotent when the environment is already healthy."""

    sid = (current_session_id.get() or '').strip()
    if not sid:
        return 'Tool error: no active session.'
    session = get_session(sid)
    result = await ensure_session_python_workspace_env(
        session,
        allow_workspace_root_fallback=True,
        bootstrap_dependencies=True,
    )
    if result is None:
        return 'Tool error: no workspace is attached to this session.'
    return result.summary
