"""LangChain tools and path helpers for the active session workspace.

Read-only tools are exposed as LangChain ``@tool`` functions. :func:`write_workspace_file_utf8`
is for backend auto-apply (not a model-facing tool). Paths are always resolved under the
session workspace root to prevent directory traversal.
"""

from __future__ import annotations

import re
from pathlib import Path

from langchain_core.tools import tool
from pypdf import PdfReader

from nemo_backend.state import current_session_id, get_session, runtime_config


def _effective_max_file_read_lines() -> int:
    v = runtime_config.tools.max_file_read_lines
    return max(50, min(int(v), 2000))


def _effective_max_search_results() -> int:
    v = runtime_config.tools.max_search_results
    return max(1, min(int(v), 200))

__all__ = [
    'TOOLS',
    'TOOL_MAP',
    'get_workspace_snapshot',
    'list_workspace_directory',
    'read_workspace_file',
    'search_workspace',
    'normalize_relative_path',
    'truncate_text',
    'get_active_workspace_root',
    'write_workspace_file_utf8',
]


def normalize_relative_path(root: Path, relative_path: str) -> Path:
    """Resolve a user/tool-relative path under root; raise if it escapes the workspace."""
    cleaned = relative_path.strip().replace('\\', '/') or '.'
    candidate = (root / cleaned).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError('Requested path is outside the active workspace.') from exc
    return candidate


def truncate_text(value: str, limit: int) -> str:
    """Truncate long strings with an explicit marker (used in SSE status lines)."""
    if len(value) <= limit:
        return value
    return f'{value[:limit]}\n... [truncated]'


def get_active_workspace_root() -> Path:
    """Return the absolute workspace path for the session in current_session_id."""
    session_id = current_session_id.get()
    if not session_id:
        raise ValueError('No active session is available.')

    session = get_session(session_id)
    if not session.workspace_path:
        raise ValueError('This conversation does not have a workspace attached.')

    return Path(session.workspace_path).resolve()


def write_workspace_file_utf8(relative_path: str, content: str) -> None:
    """Write UTF-8 text to ``relative_path`` under the active session workspace.

    Resolves with :func:`normalize_relative_path` (no path escape). Creates parent
    directories as needed. Must run with :data:`nemo_backend.state.current_session_id` set.
    """
    root = get_active_workspace_root()
    target = normalize_relative_path(root, relative_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding='utf-8', newline='\n')


@tool
def get_workspace_snapshot() -> str:
    """Return the current workspace tree snapshot and recent filesystem activity for the active conversation."""

    session_id = current_session_id.get()
    if not session_id:
        return 'No active session.'

    session = get_session(session_id)
    if not session.workspace_path:
        return 'No workspace is attached to this conversation.'

    snapshot = session.workspace_context.strip() or '[workspace tree unavailable]'
    state = session.workspace_state.strip() or '[workspace state unavailable]'
    return f'Workspace: {session.workspace_path}\n\nTree:\n{snapshot}\n\nState:\n{state}'


@tool
def list_workspace_directory(relative_path: str = '.') -> str:
    """List files and folders inside a workspace directory. Use relative paths like '.' or 'src/app'."""

    root = get_active_workspace_root()
    target = normalize_relative_path(root, relative_path)
    if not target.exists():
        raise ValueError(f'Path does not exist: {relative_path}')
    if not target.is_dir():
        raise ValueError(f'Path is not a directory: {relative_path}')

    entries = sorted(target.iterdir(), key=lambda item: (not item.is_dir(), item.name.lower()))
    lines: list[str] = []
    for entry in entries[:200]:
        marker = '/' if entry.is_dir() else ''
        lines.append(f'{entry.name}{marker}')

    if len(entries) > 200:
        lines.append('... [truncated]')

    rel_display = '.' if target == root else target.relative_to(root).as_posix()
    return f'Directory: {rel_display}\n' + ('\n'.join(lines) if lines else '[empty]')


def _read_workspace_pdf(path: Path, rel_display: str, start_page: int, end_page: int) -> str:
    """Extract text from PDF pages ``start_page``–``end_page`` (1-based, inclusive)."""
    try:
        reader = PdfReader(str(path))
    except Exception as exc:
        raise ValueError(f'Could not open PDF: {rel_display} ({exc})') from exc

    if reader.is_encrypted and reader.decrypt('') == 0:
        raise ValueError(f'PDF is password-protected: {rel_display}')

    n_pages = len(reader.pages)
    if n_pages == 0:
        return f'File: {rel_display}\nPages: (none)\n\n[empty PDF]'

    safe_start = max(1, start_page)
    cap = _effective_max_file_read_lines()
    safe_end = max(safe_start, min(end_page, safe_start + cap - 1, n_pages))
    if safe_start > n_pages:
        return (
            f'File: {rel_display}\nPages: {safe_start}-{safe_end} (document has {n_pages} page(s))\n\n'
            '[empty range]'
        )

    parts: list[str] = []
    for page_index in range(safe_start - 1, safe_end):
        try:
            raw = reader.pages[page_index].extract_text()
        except Exception as exc:
            parts.append(f'--- Page {page_index + 1} ---\n[extraction error: {exc}]')
            continue
        body = (raw or '').strip()
        parts.append(f'--- Page {page_index + 1} ---\n{body if body else "[no extractable text on this page]"}')

    header = (
        f'File: {rel_display}\n'
        f'Pages: {safe_start}-{safe_end} (of {n_pages}); parameters are page numbers for PDFs\n\n'
    )
    return header + '\n\n'.join(parts)


@tool
def read_workspace_file(
    relative_path: str,
    start_line: int = 1,
    end_line: int = 220,
    include_line_numbers: bool = True,
) -> str:
    """Read a file from the workspace.

    For plain text (UTF-8), ``start_line`` and ``end_line`` are 1-based inclusive line numbers.
    For ``.pdf`` files, the same arguments are 1-based inclusive page numbers (``include_line_numbers`` is ignored).

    Set ``include_line_numbers`` to false when you need the exact on-disk lines for ``replace_workspace_snippet``
    (old_snippet): numbered output uses a ``N: `` prefix that must not be copied into ``old_snippet``.
    """

    root = get_active_workspace_root()
    target = normalize_relative_path(root, relative_path)
    if not target.exists():
        raise ValueError(f'File does not exist: {relative_path}')
    if not target.is_file():
        raise ValueError(f'Path is not a file: {relative_path}')

    rel_display = target.relative_to(root).as_posix()

    if target.suffix.lower() == '.pdf':
        return _read_workspace_pdf(target, rel_display, start_line, end_line)

    # Clamp line range so one call cannot read unbounded megabytes.
    safe_start = max(1, start_line)
    cap = _effective_max_file_read_lines()
    safe_end = max(safe_start, min(end_line, safe_start + cap - 1))
    text = target.read_text(encoding='utf-8', errors='replace')
    lines = text.splitlines()
    excerpt = lines[safe_start - 1 : safe_end]
    body_lines = [f'{index}: {line}' for index, line in enumerate(excerpt, start=safe_start)]
    if include_line_numbers:
        body = '\n'.join(body_lines) if body_lines else ''
    else:
        body = '\n'.join(excerpt) if excerpt else ''
    return f'File: {rel_display}\nLines: {safe_start}-{safe_end}\n\n' + (body if body else '[empty range]')


@tool
def search_workspace(query: str, max_matches: int = 20) -> str:
    """Search text files in the workspace for a literal string or regex pattern and return matching lines."""

    root = get_active_workspace_root()
    limit = max(1, min(max_matches, _effective_max_search_results()))
    pattern = re.compile(query, re.IGNORECASE)
    matches: list[str] = []
    skipped = 0
    ignored_dirs = {'.git', 'node_modules', 'dist', 'build', '__pycache__', '.angular', '.cursor'}
    ignored_suffixes = {'.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.zip', '.mp3', '.mp4', '.wav'}

    for path in root.rglob('*'):
        if any(part in ignored_dirs for part in path.parts):
            continue
        if not path.is_file() or path.suffix.lower() in ignored_suffixes:
            continue
        try:
            text = path.read_text(encoding='utf-8', errors='replace')
        except OSError:
            skipped += 1
            continue

        for line_number, line in enumerate(text.splitlines(), start=1):
            if pattern.search(line):
                rel_display = path.relative_to(root).as_posix()
                matches.append(f'{rel_display}:{line_number}: {line.strip()}')
                if len(matches) >= limit:
                    summary = '\n'.join(matches)
                    if skipped:
                        summary += f'\n\nSkipped unreadable files: {skipped}'
                    return summary

    if not matches:
        return 'No matches found.'

    summary = '\n'.join(matches)
    if skipped:
        summary += f'\n\nSkipped unreadable files: {skipped}'
    return summary


TOOLS = [
    get_workspace_snapshot,
    list_workspace_directory,
    read_workspace_file,
    search_workspace,
]
TOOL_MAP = {tool_.name: tool_ for tool_ in TOOLS}
