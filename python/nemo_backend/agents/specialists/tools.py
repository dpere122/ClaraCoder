"""Tool lists for mutation specialists (minimal surface per subgraph)."""

from __future__ import annotations

from typing import Any

from nemo_backend.delete_tool import delete_workspace_entry
from nemo_backend.staging_edit_tools import stage_create_file, stage_workspace_file_overwrite


def create_specialist_tools() -> tuple[list[Any], dict[str, Any]]:
    t = [stage_create_file]
    return t, {stage_create_file.name: stage_create_file}


def update_specialist_tools(edit_tools_strict: bool) -> tuple[list[Any], dict[str, Any]]:
    del edit_tools_strict
    t = [stage_workspace_file_overwrite]
    return t, {stage_workspace_file_overwrite.name: stage_workspace_file_overwrite}


def delete_specialist_tools() -> tuple[list[Any], dict[str, Any]]:
    t = [delete_workspace_entry]
    return t, {delete_workspace_entry.name: delete_workspace_entry}
