"""LangChain tools and path helpers for the active session workspace.

Read-only tools are exposed as LangChain ``@tool`` functions. :func:`write_workspace_file`
/ :func:`write_workspace_file_utf8` are for backend helpers (not model-facing tools).
Paths are always resolved under the
session workspace root to prevent directory traversal.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

logger = logging.getLogger('nemo.tools.workspace')

from langchain_core.tools import tool
from pypdf import PdfReader

from nemo_backend.state import current_session_id, get_session, runtime_config
from nemo_backend.workspace_text_io import (
    parse_newline_mode,
    read_file_for_tools,
    validate_workspace_encoding,
    write_file_to_disk,
)
from nemo_backend.workspace_ignore import (
    get_workspace_ignore_rules_cached,
    iter_workspace_search_files,
    should_ignore_workspace_entry,
)


def _effective_max_file_read_lines() -> int:
    v = runtime_config.tools.max_file_read_lines
    return max(50, min(int(v), 2000))


def _effective_max_search_results() -> int:
    v = runtime_config.tools.max_search_results
    return max(1, min(int(v), 200))


# U+2502: separates line numbers from file text; distinct from ASCII "|" often used in code.
_READ_FILE_GUTTER_SEP = ' \u2502 '


def _format_read_excerpt_with_gutter(excerpt: list[str], line_start: int, line_end: int) -> str:
    """Join lines with a fixed-width line-number column, then separator, then verbatim file text."""
    if not excerpt:
        return ''
    # Min width keeps the text column aligned so indentation reads clearly across the excerpt.
    gutter_w = max(3, len(str(line_end)))
    return '\n'.join(
        f'{index:>{gutter_w}}{_READ_FILE_GUTTER_SEP}{line}'
        for index, line in enumerate(excerpt, start=line_start)
    )

__all__ = [
    'TOOLS',
    'TOOL_MAP',
    'list_workspace_directory',
    'read_workspace_file',
    'search_workspace',
    'normalize_relative_path',
    'truncate_text',
    'get_active_workspace_root',
    'write_workspace_file',
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


def write_workspace_file(
    relative_path: str,
    content: str,
    encoding: str = '',
    newline_mode: str = '',
) -> None:
    """Write text to ``relative_path`` using a vetted encoding and newline mode (defaults from runtime tools config).

    Resolves with :func:`normalize_relative_path` (no path escape). Creates parent
    directories as needed. Must run with :data:`nemo_backend.state.current_session_id` set.
    """
    root = get_active_workspace_root()
    target = normalize_relative_path(root, relative_path)
    enc = (encoding or '').strip() or runtime_config.tools.default_workspace_encoding
    enc = validate_workspace_encoding(enc)
    nl_raw = (newline_mode or '').strip() or runtime_config.tools.default_workspace_newline
    nl = parse_newline_mode(nl_raw)
    write_file_to_disk(target, content, enc, nl)


def write_workspace_file_utf8(relative_path: str, content: str) -> None:
    """Write UTF-8 with LF newlines (backward-compatible alias)."""
    write_workspace_file(relative_path, content, encoding='utf-8', newline_mode='lf')


@tool
def list_workspace_directory(relative_path: str = '.') -> str:
    """List files and folders inside a workspace directory. Use relative paths like '.' or 'src/app'.

    Omits paths ignored by the workspace root `.gitignore` (simple subset, same as the tree snapshot) and built-in
    skips (e.g. `node_modules`, `.git`). Use `read_workspace_file` with an explicit path if you need a gitignored file."""

    root = get_active_workspace_root()
    target = normalize_relative_path(root, relative_path)
    if not target.exists():
        raise ValueError(f'Path does not exist: {relative_path}')
    if not target.is_dir():
        raise ValueError(f'Path is not a directory: {relative_path}')

    ignore_rules = get_workspace_ignore_rules_cached(root)
    entries = sorted(target.iterdir(), key=lambda item: (not item.is_dir(), item.name.lower()))
    root_resolved = root.resolve()
    visible: list[Path] = []
    for entry in entries:
        rel_from_root = entry.resolve().relative_to(root_resolved).as_posix()
        if should_ignore_workspace_entry(entry.name, rel_from_root, ignore_rules):
            continue
        visible.append(entry)

    lines: list[str] = []
    for entry in visible[:200]:
        marker = '/' if entry.is_dir() else ''
        lines.append(f'{entry.name}{marker}')

    if len(visible) > 200:
        lines.append('... [truncated]')

    rel_display = '.' if target == root else target.relative_to(root).as_posix()
    return f'Directory: {rel_display}\n' + ('\n'.join(lines) if lines else '[empty]')


def _read_workspace_pdf(path: Path, rel_display: str, start_page: int, end_page: int) -> str:
    """Extract text from PDF pages ``start_page``–``end_page`` (1-based, inclusive)."""
    try:
        reader = PdfReader(str(path))
    except Exception as exc:
        logger.warning('PDF open failed path=%s err=%s', rel_display, exc)
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
            logger.warning('PDF page extract failed path=%s page=%s err=%s', rel_display, page_index + 1, exc)
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
    encoding: str = '',
) -> str:
    """Read a file from the workspace.

    For plain text, ``encoding`` selects the on-disk codec (default from app Settings → Tools), e.g. utf-8, utf-8-sig,
    utf-16, utf-16-le, utf-16-be, latin-1, cp1252, ascii, mac-roman. Invalid byte sequences are replaced (U+FFFD).
    ``start_line`` and ``end_line`` are 1-based inclusive line numbers after newline normalization to ``\\n``.
    For ``.pdf`` files, the same arguments are 1-based inclusive page numbers (``include_line_numbers`` and ``encoding`` are ignored).

    Set ``include_line_numbers`` to false when you need the exact on-disk lines for ``replace_workspace_snippet``
    (old_snippet): when true, each line is ``<n> │ <text>`` (Unicode U+2502)—only ``<text>`` is file content
    (including its leading spaces and tabs); do not include the gutter in ``old_snippet``.
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

    enc = (encoding or '').strip() or runtime_config.tools.default_workspace_encoding
    enc = validate_workspace_encoding(enc)

    # Clamp line range so one call cannot read unbounded megabytes.
    safe_start = max(1, start_line)
    cap = _effective_max_file_read_lines()
    safe_end = max(safe_start, min(end_line, safe_start + cap - 1))
    text = read_file_for_tools(target, enc)
    lines = text.splitlines()
    excerpt = lines[safe_start - 1 : safe_end]
    if include_line_numbers:
        body = _format_read_excerpt_with_gutter(excerpt, safe_start, safe_end)
        header = (
            f'File: {rel_display}\n'
            f'Encoding: {enc}\n'
            f'Lines: {safe_start}-{safe_end}\n'
            'Format: padded line number, then " │ ", then verbatim file text. '
            'Everything after " │ " is from disk; leading spaces and tabs there are file indentation, not the gutter.\n\n'
        )
    else:
        body = '\n'.join(excerpt) if excerpt else ''
        header = f'File: {rel_display}\nEncoding: {enc}\nLines: {safe_start}-{safe_end}\n\n'
    return header + (body if body else '[empty range]')


@tool
def search_workspace(query: str, max_matches: int = 20, encoding: str = '') -> str:
    """Search text files in the workspace for a literal string or regex pattern and return matching lines.

    ``encoding`` applies to every file scanned in this call (default from Settings → Tools); mixed-encoding trees may need multiple searches.
    Each hit is ``[path line N] │ …`` where text after `` │ `` is the full line (indentation preserved).

    Skips paths ignored by the workspace root `.gitignore` (simple subset) and built-in heavy/binary paths
    (same as `list_workspace_directory`). Use `read_workspace_file` on a known path if you must inspect a gitignored file."""

    root = get_active_workspace_root()
    root_resolved = root.resolve()
    ignore_rules = get_workspace_ignore_rules_cached(root)
    limit = max(1, min(max_matches, _effective_max_search_results()))
    pattern = re.compile(query, re.IGNORECASE)
    matches: list[str] = []
    skipped = 0

    enc = (encoding or '').strip() or runtime_config.tools.default_workspace_encoding
    enc = validate_workspace_encoding(enc)

    for path in iter_workspace_search_files(root_resolved, ignore_rules):
        try:
            text = read_file_for_tools(path, enc)
        except OSError as exc:
            logger.debug('search skip unreadable path=%s err=%s', path, exc)
            skipped += 1
            continue

        for line_number, line in enumerate(text.splitlines(), start=1):
            if pattern.search(line):
                rel_display = path.relative_to(root_resolved).as_posix()
                matches.append(
                    f'[{rel_display} line {line_number}]{_READ_FILE_GUTTER_SEP}{line}'
                )
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
    list_workspace_directory,
    read_workspace_file,
    search_workspace,
]
TOOL_MAP = {tool_.name: tool_ for tool_ in TOOLS}
