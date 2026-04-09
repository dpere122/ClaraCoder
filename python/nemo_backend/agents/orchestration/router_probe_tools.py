"""Read-only workspace probes exposed only to the nested mutation router."""

from __future__ import annotations

from langchain_core.tools import tool

from nemo_backend.workspace_tools import get_active_workspace_root, normalize_relative_path


def _split_relative_paths(raw: str) -> list[str]:
    out: list[str] = []
    for line in raw.replace(',', '\n').splitlines():
        p = line.strip()
        if p:
            out.append(p)
    return out


@tool
def workspace_path_status(relative_paths: str) -> str:
    """Check whether workspace paths exist and if each is a file or directory. Does not return file contents.

    Pass workspace-relative paths, one per line or comma-separated. Use only when Operation/Existence in the task
    are missing or contradictory—not for browsing.
    """
    root = get_active_workspace_root()
    paths = _split_relative_paths(relative_paths)
    if not paths:
        return 'No paths provided.'
    lines: list[str] = []
    for rel in paths:
        try:
            target = normalize_relative_path(root, rel)
        except ValueError as exc:
            lines.append(f'{rel}: error: {exc}')
            continue
        exists = target.exists()
        is_file = target.is_file() if exists else False
        is_dir = target.is_dir() if exists else False
        lines.append(f'{rel}: exists={exists} is_file={is_file} is_dir={is_dir}')
    return '\n'.join(lines)


__all__ = ['workspace_path_status']
