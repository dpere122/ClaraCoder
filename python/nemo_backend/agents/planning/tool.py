"""Outer-agent workspace mutation tool (invocation intercepted by LangGraph middleware)."""

from __future__ import annotations

from langchain_core.tools import tool

MODIFY_WORKSPACE_NAME = 'modify_workspace'

__all__ = ['MODIFY_WORKSPACE_NAME', 'modify_workspace']


@tool(MODIFY_WORKSPACE_NAME)
def modify_workspace(task_summary: str) -> str:
    """Execute workspace mutations (create, update, or delete files) via nested specialists.

    Pass a clear task_summary: goal, constraints, relevant file paths, and any content context the outer agent
    has already read. You cannot call edit or delete tools directly—use this tool for any workspace mutation.
    When the tool returns, reply to the user with a concise summary of what changed."""
    raise RuntimeError('modify_workspace is handled by the runtime, not invoked directly.')


PLANNING_TOOLS = [modify_workspace]
PLANNING_TOOL_MAP = {modify_workspace.name: modify_workspace}
