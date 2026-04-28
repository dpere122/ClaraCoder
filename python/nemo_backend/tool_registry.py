"""Central registry for LangChain tools and human-in-the-loop (HITL) policy.

**Outer agent** — workspace reads/search (including ``retrieve_workspace_semantic`` for checkpoint + staging recall; nested write recon uses ``retrieve_workspace_checkpoint_semantic``); ``copy_workspace_files``; ``delete_workspace_entry`` and
``batch_delete_workspace_entries`` (any path, with HITL when auto-apply is off); staged create/update tools
(``stage_create_file``, ``stage_workspace_file_overwrite``, ``stage_line_range_edit``, optional ``stage_snippet_edit``)
plus the same staging review/transfer tools as nested graphs; plus ``execute_workspace_mutation`` and ``plan_and_modify``
when Editor is on. Nested router + specialists handle staged mutations (``plan_and_modify`` may run the planner first). When Editor is on, the outer tool list also
includes the same **Python dependency** and **code-review specialist** tool surfaces as the nested graphs (merge by
name with the existing ``python_dependency_tools`` / LSP read tools), plus **workspace pytest/smoke** tools shared with
final project review (without ``approve_project_review`` / ``reject_project_review`` on the standard outer graph).

**Nested executor** — router and specialist subgraphs bind create/update/delete tools in
:mod:`nemo_backend.agents.orchestration.nested_pipeline`.

**HITL** — diff pause for edit tools; delete/copy/accept-command pauses when auto-apply is off; **staged→workspace**
``transfer_staged_file_to_workspace`` / ``approve_staged_workspace_edit`` build a diff and defer the disk write until
the user confirms in chat (or returns for re-review) unless auto-apply is on. The phased outer **verify** subgraph
also binds inspect + ``transfer_staged_file_to_workspace`` so pending drafts can land before pytest/smoke.
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
from nemo_backend.agents.specialists.review_tools import (
    DIFF_STAGED_EDIT_AGAINST_BASELINE_NAME,
    FORMAT_STAGING_FILE_BLACK_NAME,
    LIST_STAGED_EDITS_NAME,
    READ_STAGED_EDIT_NAME,
    REJECT_STAGED_WORKSPACE_EDIT_NAME,
    TRANSFER_STAGED_FILE_TO_WORKSPACE_NAME,
)
from nemo_backend.edit_tool import APPROVE_STAGED_WORKSPACE_EDIT_NAME
from nemo_backend.python_env_tools import ensure_python_workspace_env_tool
from nemo_backend.node_dependency_agent import (
    INSTALL_NPM_PACKAGES_NAME,
    NPM_INSTALL_PROJECT_NAME,
    REMOVE_NPM_PACKAGES_NAME,
    RUN_NPM_SCRIPT_NAME,
)
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
from nemo_backend.staging_edit_tools import STAGING_TOOLS
from nemo_backend.state import runtime_config
from nemo_backend.workspace_tools import TOOLS, TOOL_MAP

WORKSPACE_READ_TOOL_NAMES: frozenset[str] = frozenset(t.name for t in TOOLS)

# Outer phased graph — Verify: land pending staged→workspace transfers, then workspace tests, then LSP reads.
OUTER_VERIFY_STAGING_TRANSFER_TOOL_NAMES: frozenset[str] = frozenset(
    {
        LIST_STAGED_EDITS_NAME,
        DIFF_STAGED_EDIT_AGAINST_BASELINE_NAME,
        READ_STAGED_EDIT_NAME,
        TRANSFER_STAGED_FILE_TO_WORKSPACE_NAME,
        REJECT_STAGED_WORKSPACE_EDIT_NAME,
    }
)
# Pytest + smoke: used for verify→learn retry when output suggests failure (see ``outer_coding_cycle_graph``).
OUTER_VERIFY_ONLY_TOOL_NAMES: frozenset[str] = frozenset(
    {'run_workspace_pytest_tests', 'run_workspace_python_smoke_test'}
)


def merge_tools_replace_by_name(
    base_tools: list[Any],
    base_map: dict[str, Any],
    named_layers: list[tuple[str, list[Any]]],
) -> tuple[list[Any], dict[str, Any]]:
    """Later layers override ``base_map`` by tool ``name``; rebuild ``base_tools`` order with replacements applied."""
    out_map = dict(base_map)
    for _label, layer in named_layers:
        for tool in layer:
            out_map[tool.name] = tool
    out_tools = [out_map[t.name] for t in base_tools]
    base_names = {t.name for t in base_tools}
    for _label, layer in named_layers:
        for tool in layer:
            if tool.name not in base_names:
                out_tools.append(tool)
                base_names.add(tool.name)
    return out_tools, out_map


def staging_workspace_write_tools(edit_tools_strict: bool) -> list[Any]:
    """Staged create/update tools for the outer agent and coding planner (snippet omitted when strict)."""
    if edit_tools_strict:
        return list(STAGING_TOOLS[:-1])
    return list(STAGING_TOOLS)


def hitl_diff_pause_tools() -> frozenset[str]:
    """Tool names that may emit a diff and require human review before the agent continues."""
    names = {t.name for t in staging_workspace_write_tools(runtime_config.tools.edit_tools_strict)}
    names.add(APPROVE_STAGED_WORKSPACE_EDIT_NAME)
    names.add(TRANSFER_STAGED_FILE_TO_WORKSPACE_NAME)
    names.add(REJECT_STAGED_WORKSPACE_EDIT_NAME)
    names.add(FORMAT_STAGING_FILE_BLACK_NAME)
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
            INSTALL_NPM_PACKAGES_NAME,
            REMOVE_NPM_PACKAGES_NAME,
            NPM_INSTALL_PROJECT_NAME,
            RUN_NPM_SCRIPT_NAME,
        }
    )


def worker_tools_and_map(
    apply_mode: bool,
    *,
    edit_tools_strict_override: bool | None = None,
    include_planning_tools: bool = True,
) -> tuple[list[Any], dict[str, Any]]:
    """Tools for the outer Clara agent: reads; plus direct copy and nested mutation tools when Editor is on.

    ``edit_tools_strict_override`` — when set, drives :func:`staging_workspace_write_tools` instead of runtime Settings.

    ``include_planning_tools`` — when ``False``, omits ``plan_and_modify`` and ``execute_workspace_mutation``.
    """
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
        from nemo_backend.node_dependency_agent import node_dependency_tools

        node_dep_tools, node_dep_map = node_dependency_tools()
        tools.extend(node_dep_tools)
        mapping.update(node_dep_map)
        if include_planning_tools:
            tools.extend(PLANNING_TOOLS)
            for t in PLANNING_TOOLS:
                mapping[t.name] = t
        edit_strict = (
            edit_tools_strict_override
            if edit_tools_strict_override is not None
            else runtime_config.tools.edit_tools_strict
        )
        edit_tools = staging_workspace_write_tools(edit_strict)
        tools.extend(edit_tools)
        for t in edit_tools:
            mapping[t.name] = t
        tools.append(delete_workspace_entry)
        mapping[DELETE_WORKSPACE_ENTRY_NAME] = delete_workspace_entry
        tools.append(batch_delete_workspace_entries)
        mapping[BATCH_DELETE_WORKSPACE_ENTRIES_NAME] = batch_delete_workspace_entries
        from nemo_backend.agents.specialists.project_review_tools import (
            run_workspace_python_smoke_test,
            run_workspace_pytest_tests,
        )
        from nemo_backend.agents.specialists.review_tools import code_review_specialist_tools
        from nemo_backend.agents.specialists.tools import dependency_specialist_tools, node_dependency_specialist_tools

        tools, mapping = merge_tools_replace_by_name(
            tools,
            mapping,
            [
                ('dependency_specialist', dependency_specialist_tools()[0]),
                ('node_dependency_specialist', node_dependency_specialist_tools()[0]),
                ('code_review_specialist', code_review_specialist_tools()[0]),
                (
                    'outer_workspace_verification',
                    [run_workspace_pytest_tests, run_workspace_python_smoke_test],
                ),
            ],
        )
    return tools, mapping


def outer_phased_learn_tools_and_map() -> tuple[list[Any], dict[str, Any]]:
    """Read/search + LSP inspection only (Editor phased outer graph — learn node)."""
    tools: list[Any] = [*TOOLS, *PYTHON_LSP_READ_TOOLS]
    mapping: dict[str, Any] = dict(TOOL_MAP)
    for tool_ in PYTHON_LSP_READ_TOOLS:
        mapping[tool_.name] = tool_
    return tools, mapping


def outer_phased_write_tools_and_map(
    *,
    edit_tools_strict_override: bool | None = None,
    include_planning_tools: bool | None = None,
) -> tuple[list[Any], dict[str, Any]]:
    """Outer phased write node: full ``worker_tools_and_map(apply_mode=True)`` minus verify-only pytest/smoke."""
    orch = (
        runtime_config.tools.orchestrated_mode if include_planning_tools is None else include_planning_tools
    )
    tools, mapping = worker_tools_and_map(
        True,
        edit_tools_strict_override=edit_tools_strict_override,
        include_planning_tools=orch,
    )
    out_tools = [t for t in tools if t.name not in OUTER_VERIFY_ONLY_TOOL_NAMES]
    out_map = {t.name: t for t in out_tools}
    return out_tools, out_map


def outer_phased_verify_tools_and_map() -> tuple[list[Any], dict[str, Any]]:
    """Staging inspect + transfer, then pytest/smoke, then LSP reads (transfer tools overlap write phase)."""
    tools: list[Any] = []
    mapping: dict[str, Any] = {}
    _, full_map = worker_tools_and_map(True)
    for name in sorted(OUTER_VERIFY_STAGING_TRANSFER_TOOL_NAMES):
        t = full_map.get(name)
        if t is not None:
            tools.append(t)
            mapping[name] = t
    for name in sorted(OUTER_VERIFY_ONLY_TOOL_NAMES):
        t = full_map.get(name)
        if t is not None:
            tools.append(t)
            mapping[name] = t
    for tool_ in PYTHON_LSP_READ_TOOLS:
        tools.append(tool_)
        mapping[tool_.name] = tool_
    return tools, mapping

