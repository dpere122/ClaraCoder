"""Outer-agent workspace mutation tool (invocation intercepted by LangGraph middleware)."""

from __future__ import annotations

from langchain_core.tools import tool

MODIFY_WORKSPACE_NAME = 'modify_workspace'

__all__ = ['MODIFY_WORKSPACE_NAME', 'modify_workspace']


@tool(MODIFY_WORKSPACE_NAME)
def modify_workspace(task_summary: str) -> str:
    """Use for any workspace create/update/delete when Editor mode is on; the nested planner and specialists perform the edits.

    Pass a self-contained `task_summary`: goal, constraints, exact relative paths, and file content or behavior context
    you already gathered from reads. You cannot call edit or delete tools directly from the outer agent.
    When the tool returns, reply to the user with a concise summary of what changed."""
    raise RuntimeError('modify_workspace is handled by the runtime, not invoked directly.')


PLANNING_TOOLS = [modify_workspace]
PLANNING_TOOL_MAP = {modify_workspace.name: modify_workspace}
