"""Tool lists for mutation specialists (minimal surface per subgraph)."""

from __future__ import annotations

from typing import Any

from nemo_backend.delete_tool import delete_workspace_entry
from nemo_backend.edit_tool import apply_workspace_full_file, replace_workspace_line_range, replace_workspace_snippet


def create_specialist_tools() -> tuple[list[Any], dict[str, Any]]:
    t = [apply_workspace_full_file]
    return t, {apply_workspace_full_file.name: apply_workspace_full_file}


def update_specialist_tools(edit_tools_strict: bool) -> tuple[list[Any], dict[str, Any]]:
    if edit_tools_strict:
        t = [replace_workspace_line_range]
        return t, {replace_workspace_line_range.name: replace_workspace_line_range}
    t = [replace_workspace_line_range, replace_workspace_snippet]
    m = {replace_workspace_line_range.name: replace_workspace_line_range, replace_workspace_snippet.name: replace_workspace_snippet}
    return t, m


def delete_specialist_tools() -> tuple[list[Any], dict[str, Any]]:
    t = [delete_workspace_entry]
    return t, {delete_workspace_entry.name: delete_workspace_entry}
