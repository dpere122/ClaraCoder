"""Tool lists for mutation specialists (scoped reads + mutations per subgraph)."""

from __future__ import annotations

from typing import Any

from langchain_core.tools import tool

from nemo_backend.delete_tool import batch_delete_workspace_entries, delete_workspace_entry
from nemo_backend.agents.specialists.review_tools import read_staged_edit
from nemo_backend.lsp.tools import (
    PYTHON_LSP_READ_TOOLS,
    lsp_create_python_file,
    lsp_delete_python_file,
    lsp_update_python_file,
)
from nemo_backend.node_dependency_agent import (
    install_npm_packages_tool,
    npm_install_project_tool,
    remove_npm_packages_tool,
    run_npm_script_tool,
)
from nemo_backend.python_dependency_agent import (
    freeze_python_requirements_tool,
    install_python_packages_tool,
    install_python_requirements_file_tool,
    remove_python_packages_tool,
    write_frozen_python_requirements_file_tool,
)
from nemo_backend.staging_edit_tools import (
    stage_create_file,
    stage_line_range_edit,
    stage_snippet_edit,
    stage_workspace_file_overwrite,
)
from nemo_backend.workspace_index.semantic_tool import (
    retrieve_workspace_checkpoint_semantic,
    retrieve_workspace_semantic,
)
from nemo_backend.state import current_session_id, get_session
from nemo_backend.workspace_tools import list_workspace_directory, read_workspace_file, search_workspace

REPORT_INSUFFICIENT_WORKSPACE_RECON_NAME = 'report_insufficient_workspace_recon'


@tool
def report_insufficient_workspace_recon(what_is_missing: str) -> str:
    """Request one supplemental workspace recon when the prior `Workspace recon:` block is too thin to stage safely.

    Use **before** any staging mutation in this turn. Describe missing paths, symbols, caller/callee facts, or
    excerpts the author needs (plain text; be specific). The write pipeline may append **one** extra recon pass
    and re-invoke the author; it is not a substitute for a full planner discovery pass.
    """
    sid = current_session_id.get()
    if not sid:
        return 'Tool error: no active session.'
    text = (what_is_missing or '').strip()
    if not text:
        return 'Tool error: describe what is missing (paths, symbols, callers, excerpts).'
    session = get_session(sid)
    session.write_recon_supplement_request = text[:8000]
    return (
        'Recorded for supplemental workspace recon. Do not call staging write tools this turn; end with a short '
        'assistant message stating you are blocked until recon is refreshed.'
    )


def create_specialist_tools() -> tuple[list[Any], dict[str, Any]]:
    t = [
        read_staged_edit,
        list_workspace_directory,
        retrieve_workspace_semantic,
        search_workspace,
        read_workspace_file,
        lsp_create_python_file,
        stage_create_file,
    ]
    return t, {tool_.name: tool_ for tool_ in t}


def update_specialist_tools(edit_tools_strict: bool) -> tuple[list[Any], dict[str, Any]]:
    del edit_tools_strict
    t = [read_staged_edit, read_workspace_file, lsp_update_python_file, stage_workspace_file_overwrite]
    return t, {tool_.name: tool_ for tool_ in t}


def workspace_recon_tools() -> tuple[list[Any], dict[str, Any]]:
    """Workspace checkpoint (on-disk) reads only for the write pipeline recon phase."""
    t: list[Any] = [
        list_workspace_directory,
        retrieve_workspace_checkpoint_semantic,
        search_workspace,
        read_workspace_file,
        *PYTHON_LSP_READ_TOOLS,
    ]
    return t, {tool_.name: tool_ for tool_ in t}


def staging_author_tools(edit_tools_strict: bool) -> tuple[list[Any], dict[str, Any]]:
    """Staging draft reads and mutators for the write pipeline author phase (no workspace tree/search reads)."""
    t: list[Any] = [
        read_staged_edit,
        report_insufficient_workspace_recon,
        lsp_create_python_file,
        lsp_update_python_file,
        stage_create_file,
        stage_workspace_file_overwrite,
        stage_line_range_edit,
    ]
    if not edit_tools_strict:
        t.append(stage_snippet_edit)
    return t, {tool_.name: tool_ for tool_ in t}


def write_specialist_tools(edit_tools_strict: bool) -> tuple[list[Any], dict[str, Any]]:
    """Union of recon + author tools (tests and tooling that expect the legacy single specialist surface)."""
    recon, rm = workspace_recon_tools()
    author, am = staging_author_tools(edit_tools_strict)
    merged = [*recon, *author]
    mapping = {**rm, **am}
    return merged, mapping


def delete_specialist_tools() -> tuple[list[Any], dict[str, Any]]:
    t = [lsp_delete_python_file, batch_delete_workspace_entries, delete_workspace_entry]
    return t, {tool_.name: tool_ for tool_ in t}


def dependency_specialist_tools() -> tuple[list[Any], dict[str, Any]]:
    t = [
        install_python_packages_tool,
        remove_python_packages_tool,
        install_python_requirements_file_tool,
        freeze_python_requirements_tool,
        write_frozen_python_requirements_file_tool,
    ]
    return t, {tool_.name: tool_ for tool_ in t}


def node_dependency_specialist_tools() -> tuple[list[Any], dict[str, Any]]:
    """Node/npm/pnpm/Yarn — same tools as :func:`nemo_backend.node_dependency_agent.node_dependency_tools`."""

    t = [
        install_npm_packages_tool,
        remove_npm_packages_tool,
        npm_install_project_tool,
        run_npm_script_tool,
    ]
    return t, {tool_.name: tool_ for tool_ in t}
