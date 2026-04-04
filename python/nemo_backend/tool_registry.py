"""Central registry for LangChain tools and human-in-the-loop (HITL) policy.

Architecture
------------
**Single-agent mode** (``NEMO_MANAGER_WORKER`` false) — one model with full workspace read tools
plus optional edit tools when Editor mode is on.

**Manager agent** (``NEMO_MANAGER_WORKER`` true) — same read tools as above, plus
``delegate_workspace_task`` when Editor mode is on (``apply_mode``). It does not delegate when Editor is off.

**Worker agent** (manager/worker only) — the same workspace tool surface as single-agent mode
(read/search/snapshot/list plus optional edits from :mod:`nemo_backend.edit_tool` when Editor is on),
but **never** ``delegate_workspace_task`` (delegation is manager-only).

**HITL diff pause** — workspace edit tools may emit a diff payload; names match
:func:`hitl_diff_pause_tools` for the current runtime tools settings. When ``auto_apply_mode`` is false,
:mod:`nemo_backend.agent` pauses the HTTP stream until ``POST /chat/agent-continue``. New edit-capable tools
must be listed from :func:`nemo_backend.edit_tool.edit_tools_for_strict` and follow the pending-diff contract.

LangGraph (default): ``agent_langgraph`` uses ``create_agent`` plus
:mod:`nemo_backend.diff_review_middleware` for diff-review pause (single-agent, manager, and nested worker).
Set ``NEMO_USE_LANGGRAPH_AGENT=false`` to use the classic bind_tools loops instead.
"""

from __future__ import annotations

from typing import Any

from nemo_backend.edit_tool import edit_tools_for_strict
from nemo_backend.state import runtime_config
from nemo_backend.workspace_tools import TOOLS, TOOL_MAP

# Model-facing name for the manager-only delegation tool (must match manager_tools).
DELEGATE_WORKSPACE_TASK_NAME = 'delegate_workspace_task'

# Workspace read/search tools (same as ``TOOLS``); streamed to the UI as assistant chunks after each call.
WORKSPACE_READ_TOOL_NAMES: frozenset[str] = frozenset(t.name for t in TOOLS)


def hitl_diff_pause_tools() -> frozenset[str]:
    """Tool names that may emit a diff and require human review before the agent continues."""
    return frozenset(t.name for t in edit_tools_for_strict(runtime_config.tools.edit_tools_strict))


def worker_tools_and_map(apply_mode: bool) -> tuple[list[Any], dict[str, Any]]:
    """Return (tool_list, name -> tool) for single-agent or delegated worker (reads + optional edits; no delegate tool)."""
    tools: list[Any] = list(TOOLS)
    mapping: dict[str, Any] = dict(TOOL_MAP)
    if apply_mode:
        ed = edit_tools_for_strict(runtime_config.tools.edit_tools_strict)
        tools.extend(ed)
        for t in ed:
            mapping[t.name] = t
    return tools, mapping


def manager_tools_and_map(apply_mode: bool) -> tuple[list[Any], dict[str, Any]]:
    """Return tools for the manager: always workspace reads; plus delegate when ``apply_mode``."""
    tools: list[Any] = list(TOOLS)
    mapping: dict[str, Any] = dict(TOOL_MAP)
    if apply_mode:
        from nemo_backend.manager_tools import MANAGER_TOOLS

        tools.extend(MANAGER_TOOLS)
        for t in MANAGER_TOOLS:
            mapping[t.name] = t
    return tools, mapping
