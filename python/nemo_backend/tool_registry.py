"""Central registry for LangChain tools and human-in-the-loop (HITL) policy.

**Outer agent** — workspace reads/search (including ``retrieve_workspace_semantic`` for checkpoint + staging recall; nested write recon uses ``retrieve_workspace_checkpoint_semantic``); ``copy_workspace_files``; ``delete_workspace_entry`` and
``batch_delete_workspace_entries`` (any path, with HITL when auto-apply is off); staged create/update tools
(``stage_create_file``, ``stage_workspace_file_overwrite``, ``stage_line_range_edit``, optional ``stage_snippet_edit``);
Python LSP staging mutators (``lsp_create_python_file``, ``lsp_update_python_file``, ``lsp_delete_python_file``),
TypeScript/JavaScript LSP staging mutators (``lsp_create_typescript_file``, etc.), and GDScript LSP staging mutators
(``lsp_create_gdscript_file``, etc.);
plus the same staging review/transfer tools as nested graphs. When Editor is on, the outer tool list also
includes the same **Python dependency** and **code-review specialist** tool surfaces as the nested graphs (merge by
name with the existing ``python_dependency_tools`` / LSP read tools), ``discover_npm_projects`` / ``search_npm_packages`` for Node discovery and registry lookup, plus **local Angular CLI** (``angular_cli_tool``)
and **workspace pytest/smoke** tools shared with
final project review (without ``approve_project_review`` / ``reject_project_review`` on the standard outer graph).

When Editor and Auto-apply are both on, staging tools are replaced by direct workspace mutators
(``apply_workspace_full_file``, ``replace_workspace_line_range``, optional ``replace_workspace_snippet``).

**HITL** — diff pause for edit tools; delete/copy/accept-command pauses when auto-apply is off; **staged→workspace**
``transfer_staged_file_to_workspace`` builds a diff and defers the disk write until
the user confirms in chat (or returns for re-review) unless auto-apply is on.
"""

from __future__ import annotations

from typing import Any

from nemo_backend.copy_tool import COPY_WORKSPACE_FILES_NAME, copy_workspace_files
from nemo_backend.delete_tool import (
    BATCH_DELETE_WORKSPACE_ENTRIES_NAME,
    DELETE_WORKSPACE_ENTRY_NAME,
    batch_delete_workspace_entries,
    delete_workspace_entry,
)
from nemo_backend.agents.specialists.review_tools import (
    FORMAT_STAGING_FILE_BLACK_NAME,
    FORMAT_STAGING_FILE_PRETTIER_NAME,
    FORMAT_WORKSPACE_FILE_BLACK_NAME,
    FORMAT_WORKSPACE_FILE_PRETTIER_NAME,
    REJECT_STAGED_WORKSPACE_EDIT_NAME,
    TRANSFER_STAGED_FILE_TO_WORKSPACE_NAME,
)
from nemo_backend.python_env_tools import ensure_python_workspace_env_tool
from nemo_backend.angular_cli_tool import ANGULAR_CLI_TOOL_NAME, angular_cli_tool
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
    LSP_CREATE_GDSCRIPT_FILE_NAME,
    LSP_CREATE_PYTHON_FILE_NAME,
    LSP_CREATE_TYPESCRIPT_FILE_NAME,
    LSP_DELETE_GDSCRIPT_FILE_NAME,
    LSP_DELETE_PYTHON_FILE_NAME,
    LSP_DELETE_TYPESCRIPT_FILE_NAME,
    LSP_MUTATION_TOOLS,
    LSP_READ_TOOLS,
    LSP_UPDATE_GDSCRIPT_FILE_NAME,
    LSP_UPDATE_PYTHON_FILE_NAME,
    LSP_UPDATE_TYPESCRIPT_FILE_NAME,
)
from nemo_backend.staging_edit_tools import STAGING_TOOLS
from nemo_backend.domain import SessionState
from nemo_backend.state import direct_workspace_edits_active, runtime_config
from nemo_backend.workspace_tools import TOOLS, TOOL_MAP

WORKSPACE_READ_TOOL_NAMES: frozenset[str] = frozenset(t.name for t in TOOLS)


def merge_tools_replace_by_name(
    base_tools: list[Any],
    base_map: dict[str, Any],
    named_layers: list[tuple[str, list[Any]]],
) -> tuple[list[Any], dict[str, Any]]:
    """Later layers override ``base_map`` by tool ``name``; rebuild ``base_tools`` order with replacements applied.

    **Contract:** If a later layer lists a tool with the same ``name`` as an earlier tool, it should normally be the
    **same callable / LangChain tool object** as the base definition so descriptions and behavior cannot drift. Only
    replace with a different object when intentionally wrapping the tool; then align the wrapper docstring with the
    base tool so models do not see two conflicting explanations for one name.
    """
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
    """Staged create/update tools for the outer agent (snippet omitted when strict)."""
    if edit_tools_strict:
        return list(STAGING_TOOLS[:-1])
    return list(STAGING_TOOLS)


_LSP_CREATE_UPDATE_NAMES = frozenset(
    {
        LSP_CREATE_PYTHON_FILE_NAME,
        LSP_UPDATE_PYTHON_FILE_NAME,
        LSP_CREATE_TYPESCRIPT_FILE_NAME,
        LSP_UPDATE_TYPESCRIPT_FILE_NAME,
        LSP_CREATE_GDSCRIPT_FILE_NAME,
        LSP_UPDATE_GDSCRIPT_FILE_NAME,
    }
)

_LSP_DELETE_NAMES = frozenset(
    {
        LSP_DELETE_PYTHON_FILE_NAME,
        LSP_DELETE_TYPESCRIPT_FILE_NAME,
        LSP_DELETE_GDSCRIPT_FILE_NAME,
    }
)


def hitl_diff_pause_tools(*, direct: bool = False) -> frozenset[str]:
    """Tool names that may emit a diff and require human review before the agent continues."""
    edit_strict = runtime_config.tools.edit_tools_strict
    if direct:
        from nemo_backend.edit_tool import edit_tools_for_strict

        names = {t.name for t in edit_tools_for_strict(edit_strict)}
        names |= _LSP_CREATE_UPDATE_NAMES
        names.add(FORMAT_WORKSPACE_FILE_BLACK_NAME)
        names.add(FORMAT_WORKSPACE_FILE_PRETTIER_NAME)
        return frozenset(names)
    names = {t.name for t in staging_workspace_write_tools(edit_strict)}
    names.add(TRANSFER_STAGED_FILE_TO_WORKSPACE_NAME)
    names.add(REJECT_STAGED_WORKSPACE_EDIT_NAME)
    names.add(FORMAT_STAGING_FILE_BLACK_NAME)
    names.add(FORMAT_STAGING_FILE_PRETTIER_NAME)
    names |= _LSP_CREATE_UPDATE_NAMES
    return frozenset(names)


def hitl_delete_pause_tools() -> frozenset[str]:
    return frozenset({DELETE_WORKSPACE_ENTRY_NAME, BATCH_DELETE_WORKSPACE_ENTRIES_NAME}) | _LSP_DELETE_NAMES


def hitl_copy_pause_tools() -> frozenset[str]:
    return frozenset({COPY_WORKSPACE_FILES_NAME})


def hitl_accept_command_pause_tools() -> frozenset[str]:
    from nemo_backend.process_tools import KILL_PROCESS_NAME

    return frozenset(
        {
            INSTALL_PYTHON_PACKAGES_NAME,
            REMOVE_PYTHON_PACKAGES_NAME,
            INSTALL_PYTHON_REQUIREMENTS_FILE_NAME,
            INSTALL_NPM_PACKAGES_NAME,
            REMOVE_NPM_PACKAGES_NAME,
            NPM_INSTALL_PROJECT_NAME,
            RUN_NPM_SCRIPT_NAME,
            ANGULAR_CLI_TOOL_NAME,
            KILL_PROCESS_NAME,  
        }
    )


def worker_tools_and_map(
    apply_mode: bool,
    *,
    session: SessionState | None = None,
    edit_tools_strict_override: bool | None = None,
) -> tuple[list[Any], dict[str, Any]]:
    """Tools for the outer Clara agent: reads; plus direct copy, staging writes, and Python LSP staging mutators when Editor is on.

    ``edit_tools_strict_override`` — when set, drives staged/direct write tools instead of runtime Settings.
  When ``session`` is provided and Editor + Auto-apply are on, binds direct workspace mutators instead of staging.
    """
    from nemo_backend.process_tools import kill_process_tool, search_netstat_ports_tool

    tools: list[Any] = [*TOOLS, *LSP_READ_TOOLS, search_netstat_ports_tool]
    mapping: dict[str, Any] = dict(TOOL_MAP)
    mapping[search_netstat_ports_tool.name] = search_netstat_ports_tool
    for tool_ in LSP_READ_TOOLS:
        mapping[tool_.name] = tool_
    if apply_mode:
        sess = session or SessionState()
        direct = direct_workspace_edits_active(sess, apply_mode=apply_mode)
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
        tools.append(angular_cli_tool)
        mapping[angular_cli_tool.name] = angular_cli_tool
        edit_strict = (
            edit_tools_strict_override
            if edit_tools_strict_override is not None
            else runtime_config.tools.edit_tools_strict
        )
        if direct:
            from nemo_backend.edit_tool import edit_tools_for_strict

            edit_tools = edit_tools_for_strict(edit_strict)
        else:
            edit_tools = staging_workspace_write_tools(edit_strict)
        tools.extend(edit_tools)
        for t in edit_tools:
            mapping[t.name] = t
        tools.extend(LSP_MUTATION_TOOLS)
        for t in LSP_MUTATION_TOOLS:
            mapping[t.name] = t
        tools.append(delete_workspace_entry)
        mapping[DELETE_WORKSPACE_ENTRY_NAME] = delete_workspace_entry
        tools.append(batch_delete_workspace_entries)
        mapping[BATCH_DELETE_WORKSPACE_ENTRIES_NAME] = batch_delete_workspace_entries
        tools.append(kill_process_tool)
        mapping[kill_process_tool.name] = kill_process_tool
        from nemo_backend.agents.specialists.project_review_tools import (
            run_workspace_node_smoke_test,
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
                ('code_review_specialist', code_review_specialist_tools(direct=direct)[0]),
                (
                    'outer_workspace_verification',
                    [
                        run_workspace_pytest_tests,
                        run_workspace_python_smoke_test,
                        run_workspace_node_smoke_test,
                    ],
                ),
            ],
        )
    return tools, mapping
