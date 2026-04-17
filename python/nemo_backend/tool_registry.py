"""Central registry for LangChain tools and human-in-the-loop (HITL) policy.

**Outer agent** — workspace reads/search; ``copy_workspace_files``; ``delete_workspace_entry`` and
``batch_delete_workspace_entries`` (any path, with HITL when auto-apply is off); non-code-only direct edit tools
(``apply_workspace_full_file``, line/snippet replace); plus ``execute_workspace_mutation`` and ``plan_and_modify``
for code-review paths when Editor is on. Nested router + specialists handle staged code mutations (direct mutation
skips the coding planner; ``plan_and_modify`` may run the planner first).

**Nested executor** — router and specialist subgraphs bind create/update/delete tools in
:mod:`nemo_backend.agents.orchestration.nested_pipeline`.

**HITL** — diff pause for edit tools; delete confirmation pause for ``delete_workspace_entry`` / ``batch_delete_workspace_entries`` when auto-apply is off.
"""

from __future__ import annotations

from typing import Any

from nemo_backend.agents.planning.tool import PLANNING_TOOLS
from nemo_backend.copy_tool import COPY_WORKSPACE_FILES_NAME, copy_workspace_files
from nemo_backend.delete_tool import (
    BATCH_DELETE_WORKSPACE_ENTRIES_NAME,
    DELETE_WORKSPACE_ENTRY_NAME,
    batch_delete_workspace_entries,
    delete_workspace_entry,
)
from nemo_backend.agents.specialists.review_tools import TRANSFER_STAGED_FILE_TO_WORKSPACE_NAME
from nemo_backend.edit_tool import APPROVE_STAGED_WORKSPACE_EDIT_NAME, edit_tools_for_strict
from nemo_backend.python_env_tools import ensure_python_workspace_env_tool
from nemo_backend.python_dependency_agent import (
    INSTALL_PYTHON_PACKAGES_NAME,
    INSTALL_PYTHON_REQUIREMENTS_FILE_NAME,
    REMOVE_PYTHON_PACKAGES_NAME,
    python_dependency_tools,
)
from nemo_backend.lsp.tools import (
    LSP_CREATE_PYTHON_FILE_NAME,
    LSP_DELETE_PYTHON_FILE_NAME,
    LSP_UPDATE_PYTHON_FILE_NAME,
    PYTHON_LSP_READ_TOOLS,
)
from nemo_backend.staging_edit_tools import (
    STAGE_CREATE_FILE_NAME,
    STAGE_LINE_RANGE_EDIT_NAME,
    STAGE_SNIPPET_EDIT_NAME,
    STAGE_WORKSPACE_FILE_OVERWRITE_NAME,
)
from nemo_backend.state import runtime_config
from nemo_backend.workspace_tools import TOOLS, TOOL_MAP
WORKSPACE_READ_TOOL_NAMES: frozenset[str] = frozenset(t.name for t in TOOLS)


def hitl_diff_pause_tools() -> frozenset[str]:
    """Tool names that may emit a diff and require human review before the agent continues."""
    names = {t.name for t in edit_tools_for_strict(runtime_config.tools.edit_tools_strict)}
    names.add(APPROVE_STAGED_WORKSPACE_EDIT_NAME)
    names.add(TRANSFER_STAGED_FILE_TO_WORKSPACE_NAME)
    names.add(STAGE_CREATE_FILE_NAME)
    names.add(STAGE_WORKSPACE_FILE_OVERWRITE_NAME)
    names.add(STAGE_LINE_RANGE_EDIT_NAME)
    names.add(STAGE_SNIPPET_EDIT_NAME)
    names.add(LSP_CREATE_PYTHON_FILE_NAME)
    names.add(LSP_UPDATE_PYTHON_FILE_NAME)
    return frozenset(names)


def hitl_delete_pause_tools() -> frozenset[str]:
    return frozenset({DELETE_WORKSPACE_ENTRY_NAME, BATCH_DELETE_WORKSPACE_ENTRIES_NAME, LSP_DELETE_PYTHON_FILE_NAME})


def hitl_copy_pause_tools() -> frozenset[str]:
    return frozenset({COPY_WORKSPACE_FILES_NAME})


def hitl_accept_command_pause_tools() -> frozenset[str]:
    return frozenset(
        {
            INSTALL_PYTHON_PACKAGES_NAME,
            REMOVE_PYTHON_PACKAGES_NAME,
            INSTALL_PYTHON_REQUIREMENTS_FILE_NAME,
        }
    )


def worker_tools_and_map(apply_mode: bool) -> tuple[list[Any], dict[str, Any]]:
    """Tools for the outer Clara agent: reads; plus direct copy and nested mutation tools when Editor is on."""
    tools: list[Any] = [*TOOLS, *PYTHON_LSP_READ_TOOLS]
    mapping: dict[str, Any] = dict(TOOL_MAP)
    for tool_ in PYTHON_LSP_READ_TOOLS:
        mapping[tool_.name] = tool_
    if apply_mode:
        tools.append(copy_workspace_files)
        mapping[copy_workspace_files.name] = copy_workspace_files
        tools.append(ensure_python_workspace_env_tool)
        mapping[ensure_python_workspace_env_tool.name] = ensure_python_workspace_env_tool
        dependency_tools, dependency_map = python_dependency_tools()
        tools.extend(dependency_tools)
        mapping.update(dependency_map)
        tools.extend(PLANNING_TOOLS)
        for t in PLANNING_TOOLS:
            mapping[t.name] = t
        edit_tools = edit_tools_for_strict(runtime_config.tools.edit_tools_strict)
        tools.extend(edit_tools)
        for t in edit_tools:
            mapping[t.name] = t
        tools.append(delete_workspace_entry)
        mapping[DELETE_WORKSPACE_ENTRY_NAME] = delete_workspace_entry
        tools.append(batch_delete_workspace_entries)
        mapping[BATCH_DELETE_WORKSPACE_ENTRIES_NAME] = batch_delete_workspace_entries
    return tools, mapping
