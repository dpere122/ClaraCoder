"""Tools bound exclusively to the manager agent.

The classic manager loop and LangGraph delegate middleware intercept ``delegate_workspace_task``
and run the worker phase instead of invoking this stub, so the model still sees the correct JSON schema.
"""

from __future__ import annotations

from langchain_core.tools import tool

from nemo_backend.tool_registry import DELEGATE_WORKSPACE_TASK_NAME

__all__ = ['DELEGATE_WORKSPACE_TASK_NAME', 'MANAGER_TOOLS', 'MANAGER_TOOL_MAP', 'delegate_workspace_task']


@tool(DELEGATE_WORKSPACE_TASK_NAME)
def delegate_workspace_task(task_summary: str) -> str:
    """Delegate a workspace task to the worker agent.

    Pass a clear summary (goal, constraints, paths or filenames). The worker has the same
    workspace read/edit tools as you except it cannot call `delegate_workspace_task`.
    """
    raise RuntimeError('delegate_workspace_task is handled by the manager loop, not invoked directly.')


MANAGER_TOOLS = [delegate_workspace_task]
MANAGER_TOOL_MAP = {delegate_workspace_task.name: delegate_workspace_task}
