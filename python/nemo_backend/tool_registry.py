"""Central registry for LangChain tools and human-in-the-loop (HITL) policy.

**Outer agent** — workspace reads/search; ``modify_workspace`` when Editor is on (mutations run in nested
router + specialists).

**Nested executor** — router and specialist subgraphs bind create/update/delete tools in
:mod:`nemo_backend.agents.orchestration.nested_pipeline`.

**HITL** — diff pause for edit tools; delete confirmation pause for ``delete_workspace_entry`` when auto-apply is off.
"""

from __future__ import annotations

from typing import Any

from nemo_backend.agents.planning.tool import MODIFY_WORKSPACE_NAME, PLANNING_TOOLS
from nemo_backend.delete_tool import DELETE_WORKSPACE_ENTRY_NAME, delete_workspace_entry
from nemo_backend.edit_tool import APPROVE_STAGED_WORKSPACE_EDIT_NAME, edit_tools_for_strict
from nemo_backend.state import runtime_config
from nemo_backend.workspace_tools import TOOLS, TOOL_MAP
WORKSPACE_READ_TOOL_NAMES: frozenset[str] = frozenset(t.name for t in TOOLS)


def hitl_diff_pause_tools() -> frozenset[str]:
    """Tool names that may emit a diff and require human review before the agent continues."""
    names = {t.name for t in edit_tools_for_strict(runtime_config.tools.edit_tools_strict)}
    names.add(APPROVE_STAGED_WORKSPACE_EDIT_NAME)
    return frozenset(names)


def hitl_delete_pause_tools() -> frozenset[str]:
    return frozenset({DELETE_WORKSPACE_ENTRY_NAME})


def worker_tools_and_map(apply_mode: bool) -> tuple[list[Any], dict[str, Any]]:
    """Tools for the outer Clara agent: reads; plus ``modify_workspace`` when Editor is on."""
    tools: list[Any] = list(TOOLS)
    mapping: dict[str, Any] = dict(TOOL_MAP)
    if apply_mode:
        tools.extend(PLANNING_TOOLS)
        for t in PLANNING_TOOLS:
            mapping[t.name] = t
    return tools, mapping
