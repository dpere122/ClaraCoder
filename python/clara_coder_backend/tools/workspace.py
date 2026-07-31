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
from typing import Annotated

logger = logging.getLogger('clara.tools.workspace')

from langchain_core.tools import tool

from clara_coder_backend.workspace.search_backend import SearchCandidate, run_grep_line_search, run_grep_workspace_recursive
from clara_coder_backend.tools.semantic import retrieve_workspace_checkpoint_semantic, retrieve_workspace_semantic
from clara_coder_backend.tools.tool_conventions import (
    ENCODING_NEWLINE,
    GUTTER,
    ONE_BASED,
    RELATIVE_PATH,
    clamp_line_window,
    describe,
)
from clara_coder_backend.session.state import current_session_id, get_session, runtime_config
from clara_coder_backend.workspace.workspace_text_io import (
    parse_newline_mode,
    read_file_for_search_tools,
    read_file_for_tools,
    read_file_line_window_for_tools,
    validate_workspace_encoding,
    write_file_to_disk,
)
from clara_coder_backend.workspace.workspace_ignore import (
    WORKSPACE_CONTEXT_IGNORED_NAMES,
    get_workspace_ignore_rules_cached,
    is_node_modules_bulk_listing_path,
    iter_workspace_search_files,
    should_ignore_workspace_entry,
    workspace_expose_all_files,
)


def _effective_max_file_read_lines() -> int:
    v = runtime_config.tools.max_file_read_lines
    return max(50, min(int(v), 2000))


def _effective_max_search_results() -> int:
    v = runtime_config.tools.max_search_results
    return max(1, min(int(v), 200))


# U+2502: separates line numbers from file text; distinct from ASCII "|" often used in code.
_READ_FILE_GUTTER_SEP = ' \u2502 '


def _read_workspace_file_missing_on_disk_message(relative_path: str) -> str:
    """Return as tool output (do not raise): uncaught tool exceptions abort nested LangGraph agents."""
    return (
        f'Tool note: `{relative_path}` is not on the workspace disk yet. '
        '`read_workspace_file` only reads files already written under the workspace root. '
        'If the file exists only as a **staged** draft, use `list_staged_edits` and `read_staged_edit`; '
        'after `transfer_staged_file_to_workspace`, read it here again. '
        'If it was never created, use `stage_create_file` (or the appropriate stage tool) then transfer when ready.'
    )


def _read_workspace_file_not_a_file_message(relative_path: str) -> str:
    return (
        f'Tool note: `{relative_path}` exists but is not a regular file. '
        'Use `list_workspace_directory` to inspect directories, or pick a file path.'
    )


def _list_workspace_directory_missing_message(relative_path: str) -> str:
    """Return as tool output (do not raise): uncaught tool exceptions abort nested LangGraph agents."""
    return (
        f'Tool note: `{relative_path}` is not on the workspace disk. '
        'Use `.` to list the workspace root, `search_workspace` to find paths by name, '
        'or `read_workspace_file` if you already know a file path.'
    )


def _list_workspace_directory_not_dir_message(relative_path: str) -> str:
    return (
        f'Tool note: `{relative_path}` exists but is not a directory. '
        'Use `read_workspace_file` for file contents, or list the parent directory.'
    )


def _read_workspace_plain_text_header(
    *,
    rel_display: str,
    encoding: str,
    safe_start: int,
    safe_end: int,
    cap: int,
    excerpt: list[str],
    n_lines: int,
    include_line_numbers: bool,
) -> tuple[str, int, int]:
    """Return (header block, shown_start, shown_end) for plain-text ``read_workspace_file``."""

    if excerpt:
        shown_start = safe_start
        shown_end = safe_start + len(excerpt) - 1
        lines_meta = f'Lines: {shown_start}-{shown_end} (of {n_lines} in file)'
    else:
        shown_start = safe_start
        shown_end = safe_end
        lines_meta = f'Lines: requested {safe_start}-{safe_end} (of {n_lines} in file)'

    hints: list[str] = []
    if excerpt and safe_start > 1:
        hints.append(f'lines 1-{safe_start - 1} omitted above')
    if excerpt and shown_end < n_lines:
        hints.append(f'lines {shown_end + 1}-{n_lines} omitted below')
    if safe_end == safe_start + cap - 1 and n_lines > safe_end:
        hints.append('further lines omitted by max lines per tool call; narrow the range or call again with a higher start_line')

    hint_block = ''
    if hints:
        hint_block = f'\n[Excerpt: {"; ".join(hints)}]'

    if include_line_numbers:
        header = (
            f'File: {rel_display}\n'
            f'Encoding: {encoding}\n'
            f'{lines_meta}{hint_block}\n'
            'Format: padded line number, then " │ ", then verbatim file text. '
            'Everything after " │ " is from disk; leading spaces and tabs there are file indentation, not the gutter.\n\n'
        )
    else:
        header = f'File: {rel_display}\nEncoding: {encoding}\n{lines_meta}{hint_block}\n\n'

    return header, shown_start, shown_end


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


def truncate_text_head_tail(value: str, limit: int, *, marker: str = '\n... [truncated middle] ...\n') -> str:
    """Truncate by keeping a head and tail slice so failure lines near the end stay visible."""
    if len(value) <= limit:
        return value
    marker_len = len(marker)
    if limit <= marker_len + 16:
        return truncate_text(value, limit)
    budget = limit - marker_len
    # Bias toward the tail (typical logs: banner at start, errors at end).
    head_n = max(1, budget * 12 // 100)
    tail_n = budget - head_n
    return f'{value[:head_n]}{marker}{value[-tail_n:]}'


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
    directories as needed. Must run with :data:`clara_coder_backend.session.state.current_session_id` set.
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


@tool(description=describe(
        'List immediate children of one workspace directory (names only; dirs end with `/`).',
        when='need subtree layout after the system workspace tree is stale or too coarse.',
        not_='file contents (use `read_workspace_file`); line-level grep across the repo (use `search_workspace`).',
        shape=(
            f'`relative_path` {RELATIVE_PATH} (e.g. `.`, `src/app`); omits `.gitignore` subset and built-in skips '
            '(same as `search_workspace`). For gitignored paths, read that path directly with `read_workspace_file`.'
        ),
    ))
def list_workspace_directory(
    relative_path: Annotated[str, 'workspace-relative POSIX path'] = '.',
) -> str:

    root = get_active_workspace_root()
    try:
        target = normalize_relative_path(root, relative_path)
    except ValueError as exc:
        return f'Tool note: {exc}'
    if not target.exists():
        return _list_workspace_directory_missing_message(relative_path)
    if not target.is_dir():
        return _list_workspace_directory_not_dir_message(relative_path)

    rel_display = '.' if target == root else target.relative_to(root).as_posix()
    if is_node_modules_bulk_listing_path(rel_display):
        return (
            f'Directory: {rel_display}\n'
            '[node_modules bulk listing disabled. Use `search_workspace` with a precise query '
            '(and optional path segment in the query) to find packages or files inside dependencies.]'
        )

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

    return f'Directory: {rel_display}\n' + ('\n'.join(lines) if lines else '[empty]')


def _read_workspace_pdf(path: Path, rel_display: str, start_page: int, end_page: int) -> str:
    """Extract text from PDF pages ``start_page``–``end_page`` (1-based, inclusive)."""
    try:
        from pypdf import PdfReader
    except (ImportError, AttributeError) as exc:
        raise ValueError(
            'PDF reading needs Pillow + pypdf. From your venv run: pip install pillow pypdf '
            f'(detail: {exc})'
        ) from exc
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

    cap = _effective_max_file_read_lines()
    safe_start, safe_end = clamp_line_window(start_page, end_page, cap, max_value=n_pages)
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


def _search_workspace_python(
    root_resolved: Path,
    ignore_rules: list[str],
    *,
    pattern: re.Pattern[str],
    limit: int,
    encoding: str,
) -> tuple[list[str], int]:
    matches: list[str] = []
    skipped = 0
    for path in iter_workspace_search_files(root_resolved, ignore_rules):
        try:
            text = read_file_for_search_tools(path, encoding)
        except OSError as exc:
            logger.debug('search skip unreadable path=%s err=%s', path, exc)
            skipped += 1
            continue
        if text is None:
            skipped += 1
            continue
        for line_number, line in enumerate(text.splitlines(), start=1):
            if pattern.search(line):
                rel_display = path.relative_to(root_resolved).as_posix()
                matches.append(f'[{rel_display} line {line_number}]{_READ_FILE_GUTTER_SEP}{line}')
                if len(matches) >= limit:
                    return matches, skipped
    return matches, skipped


def _search_match_ignored(display_path: str, ignore_rules: list[str]) -> bool:
    """True when a grep hit path should be hidden by the same rules as list/search walks."""
    normalized = display_path.replace('\\', '/').strip('/')
    if not normalized:
        return False
    entry_name = Path(normalized).name
    return should_ignore_workspace_entry(entry_name, normalized, ignore_rules)


def _search_workspace_grep(
    root_resolved: Path,
    ignore_rules: list[str],
    *,
    query: str,
    limit: int,
    encoding: str,
) -> tuple[list[str], int] | None:
    # Over-fetch so post-filtering gitignore / built-in ignores can still fill ``limit``.
    fetch_limit = max(limit, min(limit * 4, 200))
    grep_matches = run_grep_workspace_recursive(
        root_resolved,
        query,
        max_matches=fetch_limit,
        encoding=encoding,
        exclude_dir_names=WORKSPACE_CONTEXT_IGNORED_NAMES,
        include_node_modules=workspace_expose_all_files(),
    )
    if grep_matches is None:
        candidates: list[SearchCandidate] = []
        path_by_display: dict[str, Path] = {}
        for path in iter_workspace_search_files(root_resolved, ignore_rules):
            rel_path = path.relative_to(root_resolved)
            rel_command_path = str(rel_path)
            rel_display = rel_path.as_posix()
            candidates.append(SearchCandidate(command_path=rel_command_path, display_path=rel_display))
            path_by_display[rel_display] = path
        grep_matches = run_grep_line_search(
            query,
            candidates,
            max_matches=limit,
            encoding=encoding,
            cwd=root_resolved,
        )
        if grep_matches is None:
            return None
    else:
        grep_matches = [m for m in grep_matches if not _search_match_ignored(m.display_path, ignore_rules)][
            :limit
        ]
        path_by_display = {
            match.display_path: root_resolved / match.display_path for match in grep_matches
        }

    rendered: list[str] = []
    skipped = 0
    lines_cache: dict[Path, list[str]] = {}
    for match in grep_matches:
        path = path_by_display.get(match.display_path)
        if path is None:
            continue
        try:
            file_lines = lines_cache.get(path)
            if file_lines is None:
                text = read_file_for_search_tools(path, encoding)
                if text is None:
                    skipped += 1
                    continue
                file_lines = text.splitlines()
                lines_cache[path] = file_lines
        except OSError as exc:
            logger.debug('search grep reread skip unreadable path=%s err=%s', path, exc)
            skipped += 1
            continue
        if 1 <= match.line_number <= len(file_lines):
            rendered.append(
                f'[{match.display_path} line {match.line_number}]{_READ_FILE_GUTTER_SEP}{file_lines[match.line_number - 1]}'
            )
    return rendered, skipped


@tool(description=describe(
        'Read a **window** of literal on-disk workspace text or PDF extract (not staging, not semantic).',
        when='need exact bytes-as-text for a known path; LSP insufficient for spans or non-LSP files.',
        not_=(
            'pending drafts (use `read_staged_edit` / diff tools); unknown locations '
            '(use `retrieve_workspace_semantic` then verify); line grep across repo (use `search_workspace`).'
        ),
        shape=(
            f'`relative_path` {RELATIVE_PATH} {ENCODING_NEWLINE} '
            'codec must pass `validate_workspace_encoding` (invalid bytes → U+FFFD). '
            f'Plain text: `start_line`/`end_line` {ONE_BASED} '
            'output capped by `maxFileReadLines` (not EOF—widen range or call again; header shows total lines and excerpt hints). '
            'PDF: same args are **1-based inclusive page numbers**; `include_line_numbers` and `encoding` ignored. '
            f'{GUTTER}'
        ),
    ))
def read_workspace_file(
    relative_path: Annotated[str, 'workspace-relative POSIX path'],
    start_line: Annotated[int, '1-based inclusive'] = 1,
    end_line: Annotated[int, '1-based inclusive'] = 220,
    include_line_numbers: Annotated[bool, 'false for raw lines / snippet matches'] = True,
    encoding: Annotated[str, 'empty = Settings default'] = '',
) -> str:

    root = get_active_workspace_root()
    target = normalize_relative_path(root, relative_path)
    if not target.exists():
        return _read_workspace_file_missing_on_disk_message(relative_path)
    if not target.is_file():
        return _read_workspace_file_not_a_file_message(relative_path)

    rel_display = target.relative_to(root).as_posix()

    if target.suffix.lower() == '.pdf':
        return _read_workspace_pdf(target, rel_display, start_line, end_line)

    enc = (encoding or '').strip() or runtime_config.tools.default_workspace_encoding
    enc = validate_workspace_encoding(enc)

    # Clamp line range so one call cannot read unbounded megabytes.
    cap = _effective_max_file_read_lines()
    safe_start, safe_end = clamp_line_window(start_line, end_line, cap)
    window = read_file_line_window_for_tools(target, enc, safe_start, safe_end)
    excerpt = window.excerpt_lines
    n_lines = window.n_lines
    header, shown_start, shown_end = _read_workspace_plain_text_header(
        rel_display=rel_display,
        encoding=enc,
        safe_start=safe_start,
        safe_end=safe_end,
        cap=cap,
        excerpt=excerpt,
        n_lines=n_lines,
        include_line_numbers=include_line_numbers,
    )
    if include_line_numbers:
        body = _format_read_excerpt_with_gutter(excerpt, shown_start, shown_end) if excerpt else ''
    else:
        body = '\n'.join(excerpt) if excerpt else ''
    return header + (body if body else '[empty range]')


@tool(description=describe(
        'Grep the **on-disk workspace** for a literal or regex (case-insensitive), returning matching lines with path:line.',
        when='known needle or pattern across tracked-ish files; need line-precise disk hits.',
        not_='staging drafts (use `search_staged_edits`); fuzzy/topic discovery (use `retrieve_workspace_semantic` then verify).',
        shape=(
            f'{ENCODING_NEWLINE} one encoding per call—mixed trees may need multiple calls. '
            'Hits `[path line N] │ full line` (indent preserved). Same ignore rules as `list_workspace_directory`; '
            'for gitignored files read with `read_workspace_file`. `query` is a **regex**: a literal code snippet '
            'containing `( ) [ ] { } . * + ? ^ $ |` (e.g. a call like `foo("bar"`) is parsed as a pattern and can '
            'error on unbalanced brackets/parens—escape those characters (`\\(`, `\\)`, …) or search a shorter, '
            'metacharacter-free substring instead.'
        ),
    ))
def search_workspace(
    query: str,
    max_matches: int = 20,
    encoding: Annotated[str, 'empty = Settings default'] = '',
) -> str:

    root = get_active_workspace_root()
    root_resolved = root.resolve()
    ignore_rules = get_workspace_ignore_rules_cached(root)
    limit = max(1, min(max_matches, _effective_max_search_results()))
    try:
        pattern = re.compile(query, re.IGNORECASE)
    except re.error as exc:
        return (
            f'Tool error: invalid regex: {exc}. If you meant a literal string (not a pattern), escape regex '
            'metacharacters like ( ) [ ] { } . * + ? ^ $ | \\ or search a shorter, unambiguous substring instead.'
        )

    enc = (encoding or '').strip() or runtime_config.tools.default_workspace_encoding
    enc = validate_workspace_encoding(enc)

    grep_result = _search_workspace_grep(
        root_resolved,
        ignore_rules,
        query=query,
        limit=limit,
        encoding=enc,
    )
    if grep_result is None:
        matches, skipped = _search_workspace_python(
            root_resolved,
            ignore_rules,
            pattern=pattern,
            limit=limit,
            encoding=enc,
        )
    else:
        matches, skipped = grep_result

    if not matches:
        return 'No matches found.'

    summary = '\n'.join(matches)
    if skipped:
        summary += f'\n\nSkipped unreadable files: {skipped}'
    return summary


from clara_coder_backend.tools.workspace_image import read_workspace_image
from clara_coder_backend.tools.wsdl_tools import WSDL_TOOLS
from clara_coder_backend.tools.xml_tools import XML_TOOLS
from clara_coder_backend.tools.json_tools import JSON_TOOLS

TOOLS = [
    list_workspace_directory,
    retrieve_workspace_semantic,
    retrieve_workspace_checkpoint_semantic,
    search_workspace,
    read_workspace_file,
    read_workspace_image,
    *WSDL_TOOLS,
    *XML_TOOLS,
    *JSON_TOOLS,
]
TOOL_MAP = {tool_.name: tool_ for tool_ in TOOLS}
