"""Tool lists for mutation specialists (scoped reads + mutations per subgraph)."""

from __future__ import annotations

from typing import Any

from nemo_backend.delete_tool import batch_delete_workspace_entries, delete_workspace_entry
from nemo_backend.agents.specialists.review_tools import read_staged_edit
from nemo_backend.lsp.tools import (
    lsp_create_python_file,
    lsp_delete_python_file,
    lsp_update_python_file,
)
from nemo_backend.python_dependency_agent import (
    freeze_python_requirements_tool,
    install_python_packages_tool,
    install_python_requirements_file_tool,
    remove_python_packages_tool,
    write_frozen_python_requirements_file_tool,
)
from nemo_backend.staging_edit_tools import stage_create_file, stage_workspace_file_overwrite
from nemo_backend.workspace_tools import list_workspace_directory, read_workspace_file, search_workspace


def create_specialist_tools() -> tuple[list[Any], dict[str, Any]]:
    t = [
        read_staged_edit,
        read_workspace_file,
        list_workspace_directory,
        search_workspace,
        lsp_create_python_file,
        stage_create_file,
    ]
    return t, {tool_.name: tool_ for tool_ in t}


def update_specialist_tools(edit_tools_strict: bool) -> tuple[list[Any], dict[str, Any]]:
    del edit_tools_strict
    t = [read_staged_edit, read_workspace_file, lsp_update_python_file, stage_workspace_file_overwrite]
    return t, {tool_.name: tool_ for tool_ in t}


def write_specialist_tools(edit_tools_strict: bool) -> tuple[list[Any], dict[str, Any]]:
    """Unified create + update specialist: new files, full-file rewrites, and staged revisions."""
    del edit_tools_strict
    t = [
        read_staged_edit,
        read_workspace_file,
        list_workspace_directory,
        search_workspace,
        lsp_create_python_file,
        lsp_update_python_file,
        stage_create_file,
        stage_workspace_file_overwrite,
    ]
    return t, {tool_.name: tool_ for tool_ in t}


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
