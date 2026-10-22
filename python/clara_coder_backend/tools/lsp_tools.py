"""LangChain tools for LSP context and diagnostics (edits go through :mod:`clara_coder_backend.tools.edit`)."""

from __future__ import annotations

from typing import Annotated, Any

from langchain_core.tools import tool

from clara_coder_backend.lsp.diagnostics import (
    diagnostics_pending_note,
    diagnostics_session_aggregate_preamble,
    format_diagnostics_summary,
)
from clara_coder_backend.lsp.file_policy import lsp_server_for_path, normalize_relative_posix_path
from clara_coder_backend.lsp.manager import (
    LspServerKind,
    diagnostics_cache_for_scope,
    get_session_lsp_manager,
    notify_session_lsp_disk_changes,
)
from clara_coder_backend.lsp.registry import display_label_for_server
from clara_coder_backend.tools.tool_conventions import RELATIVE_PATH, describe
from clara_coder_backend.session.state import current_session_id, get_session, runtime_config
from clara_coder_backend.workspace.workspace_text_io import validate_workspace_encoding

LSP_GET_DIAGNOSTICS_NAME = 'lsp_get_diagnostics'
LSP_HOVER_NAME = 'lsp_hover'
LSP_DEFINITION_NAME = 'lsp_find_definition'
LSP_REFERENCES_NAME = 'lsp_find_references'
LSP_DOCUMENT_SYMBOLS_NAME = 'lsp_get_document_symbols'

__all__ = [
    'LSP_GET_DIAGNOSTICS_NAME',
    'LSP_HOVER_NAME',
    'LSP_DEFINITION_NAME',
    'LSP_REFERENCES_NAME',
    'LSP_DOCUMENT_SYMBOLS_NAME',
    'LSP_READ_TOOLS',
]


def _require_lsp_read_path(relative_path: str) -> tuple[str, LspServerKind]:
    rel = normalize_relative_posix_path(relative_path)
    server = lsp_server_for_path(rel)
    if not server:
        raise ValueError(
            f'LSP read tools only support `.py`, `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.gd`, and `.java`. '
            f'Got `{rel}`.'
        )
    return rel, server


def _format_hover_contents(contents: Any) -> str:
    if isinstance(contents, str):
        return contents.strip()
    if isinstance(contents, list):
        parts = [_format_hover_contents(item) for item in contents]
        return '\n\n'.join(part for part in parts if part)
    if isinstance(contents, dict):
        # Legacy ``MarkedString``: ``{language, value}`` (or ``{language, text}``) → fenced code block.
        # ``MarkupContent``: ``{kind, value}`` → return the markdown/plaintext value as-is.
        language = str(contents.get('language') or '').strip()
        value = contents.get('value')
        if language:
            text = str(value if value is not None else contents.get('text') or '').strip()
            return f'```{language}\n{text}\n```' if text else ''
        if value is not None:
            return str(value).strip()
        return str(contents.get('text') or '').strip()
    return str(contents).strip()


def _workspace_rel_from_uri(manager: Any, uri: str) -> str | None:
    from clara_coder_backend.lsp.manager import _uri_to_path  # local import keeps public API small

    try:
        target = _uri_to_path(uri)
    except ValueError:
        return None
    try:
        return target.relative_to(manager.workspace_root).as_posix()
    except Exception:
        return target.as_posix()


def _format_locations(manager: Any, items: Any) -> str:
    if not items:
        return 'No locations found.'
    if isinstance(items, dict):
        items = [items]
    lines: list[str] = []
    for item in items[:50]:
        if not isinstance(item, dict):
            continue
        uri = str(item.get('uri') or item.get('targetUri') or '')
        rng = item.get('range') or item.get('targetSelectionRange') or item.get('targetRange') or {}
        start = rng.get('start') if isinstance(rng, dict) else {}
        rel = _workspace_rel_from_uri(manager, uri) if uri else '(unknown)'
        if not rel:
            continue
        lines.append(
            f'- `{rel}`:{int(start.get("line", 0)) + 1}:{int(start.get("character", 0)) + 1}'
        )
    return '\n'.join(lines) if lines else 'No locations found.'


def _format_symbols(items: Any, *, depth: int = 0) -> list[str]:
    lines: list[str] = []
    if not isinstance(items, list):
        return lines
    for item in items:
        if not isinstance(item, dict):
            continue
        name = str(item.get('name') or '(unnamed)')
        kind = item.get('kind')
        rng = item.get('selectionRange') or item.get('range') or {}
        start = rng.get('start') if isinstance(rng, dict) else {}
        indent = '  ' * depth
        lines.append(f'{indent}- {name} (kind={kind}, line={int(start.get("line", 0)) + 1})')
        lines.extend(_format_symbols(item.get('children'), depth=depth + 1))
    return lines


def _lsp_server_label(server: str) -> str:
    return display_label_for_server(server)


def _format_lsp_tool_error(
    action: str,
    exc: Exception,
    *,
    relative_path: str = '',
    server: str | None = None,
) -> str:
    rel = normalize_relative_posix_path(relative_path) if relative_path else ''
    detail = ' '.join(str(exc).strip().split()) or exc.__class__.__name__
    label = _lsp_server_label(server) if server else 'LSP'
    message = f'Tool error: {label} LSP {action} failed'
    if rel:
        message += f' for `{rel}`'
    message += f' ({detail}).'
    lowered = detail.lower()
    if (
        'lsp client closed' in lowered
        or 'initialize' in lowered
        or 'basedpyright' in lowered
        or 'vtsls' in lowered
        or '@vtsls/language-server' in lowered
    ):
        message += ' The backend could not start the configured language server (check Node for TS/JS or Python env for .py).'
    return message


def _agent_manager(server: LspServerKind) -> Any:
    """Workspace-scope manager for agent queries (never changes the session's default scope)."""

    return get_session_lsp_manager(server=server, scope='workspace', set_active=False)


def _default_encoding() -> str:
    return validate_workspace_encoding(runtime_config.tools.default_workspace_encoding or 'utf-8')


def _file_diagnostics(
    *,
    relative_path: str,
    server: LspServerKind,
    encoding: str,
    refresh_active_document: bool,
) -> str:
    manager = _agent_manager(server)
    if refresh_active_document:
        manager.mark_diagnostics_stale(relative_path)
    version_before = manager.document_version(relative_path)
    try:
        # Always checked against disk (digest-skipped when unchanged): a file the server already
        # has open may have been rewritten by run_command, git, or the copy tool since.
        manager.sync_for_agent(relative_path, encoding=encoding, wait_for_diagnostics=True)
    except Exception as exc:
        cached_items = manager.get_diagnostics(relative_path)
        if cached_items:
            return (
                format_diagnostics_summary(
                    relative_path,
                    cached_items,
                    lsp_scope='workspace',
                    analyzed_source='cached',
                    server_kind=server,
                )
                + f'\n\nNote: {_lsp_server_label(server)} LSP refresh failed ({exc}); these may be stale.'
            )
        raise
    analyzed_source = 'workspace_file' if manager.document_version(relative_path) != version_before else 'cached'
    text = format_diagnostics_summary(
        relative_path,
        manager.get_diagnostics(relative_path),
        lsp_scope='workspace',
        analyzed_source=analyzed_source,
        server_kind=server,
    )
    if not manager.diagnostics_fresh(relative_path):
        text += '\n\n' + diagnostics_pending_note(server)
    return text


def _aggregate_cached_diagnostics(session_id: str, encoding: str = 'utf-8') -> str:
    notify_session_lsp_disk_changes(session_id, ['.'], ['unknown'], encoding=encoding)
    cache = diagnostics_cache_for_scope(get_session(session_id), 'workspace')
    all_rows: list[dict[str, Any]] = []
    for path in sorted(cache):
        all_rows.extend(cache[path])
    if not all_rows:
        return 'No cached LSP diagnostics are available.'
    lines = [
        diagnostics_session_aggregate_preamble('workspace'),
        f'Cached LSP diagnostics ({len(all_rows)} issue(s)):',
    ]
    for item in all_rows[:100]:
        lines.append(
            f"- `{item['relative_path']}` {item['line']}:{item['character']} [{item['severity']}] {item['message']}"
        )
    if len(all_rows) > 100:
        lines.append(f'... {len(all_rows) - 100} more diagnostic(s) omitted.')
    return '\n'.join(lines)


_LSP_EXTENSIONS = '`.py`, `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs`, `.gd`, `.java`'
_POSITION = f'1-based `line`/`character`; {_LSP_EXTENSIONS}'


@tool(LSP_GET_DIAGNOSTICS_NAME, description=describe(
    'Return LSP diagnostics for one file, or every cached diagnostic when `relative_path` is empty',
    when='checking errors after edits or auditing workspace health',
    shape=f'{_LSP_EXTENSIONS}; always checked against the file on disk; `refresh_active_document=true` forces a new analysis pass',
))
def lsp_get_diagnostics(
    relative_path: Annotated[str, f'{RELATIVE_PATH}; empty = all cached'] = '',
    refresh_active_document: Annotated[bool, 'force the server to re-analyze even if the file is unchanged'] = False,
    encoding: Annotated[str, 'empty = Settings default'] = '',
) -> str:
    rel = normalize_relative_posix_path(relative_path)
    try:
        enc = validate_workspace_encoding(
            (encoding or '').strip() or (runtime_config.tools.default_workspace_encoding or 'utf-8')
        )
        if rel:
            rel2, server = _require_lsp_read_path(rel)
            return _file_diagnostics(
                relative_path=rel2,
                server=server,
                encoding=enc,
                refresh_active_document=bool(refresh_active_document),
            )
        sid_tool = (current_session_id.get() or '').strip()
        if not sid_tool:
            return 'No cached LSP diagnostics are available.'
        return _aggregate_cached_diagnostics(sid_tool, enc)
    except Exception as exc:
        srv = lsp_server_for_path(rel) if rel else None
        return _format_lsp_tool_error('diagnostics lookup', exc, relative_path=rel, server=srv)


@tool(LSP_HOVER_NAME, description=describe('Resolve LSP hover information at a line/character position.',
        when='need type docs or quick symbol context at cursor.',
        not_='whole-file reads (use `read_workspace_file`).',
        shape=_POSITION,))
def lsp_hover(
    relative_path: Annotated[str, RELATIVE_PATH],
    line: Annotated[int, '1-based line'],
    character: Annotated[int, '1-based column'],
) -> str:

    try:
        rel, server = _require_lsp_read_path(relative_path)
        manager = _agent_manager(server)
        manager.sync_for_agent(rel, encoding=_default_encoding())
        result = manager.hover(rel, int(line), int(character))
        contents = _format_hover_contents(result.get('contents'))
        if not contents:
            return f'No hover information for `{rel}` at {line}:{character}.'
        return f'Hover for `{rel}` at {line}:{character}:\n\n{contents}'
    except Exception as exc:
        srv = lsp_server_for_path(normalize_relative_posix_path(relative_path))
        return _format_lsp_tool_error('hover lookup', exc, relative_path=relative_path, server=srv)


@tool(LSP_DEFINITION_NAME, description=describe('Find the definition location for the symbol at a line/character position.',
        when='jumping to where a symbol is declared.',
        not_='listing all symbols (use `lsp_get_document_symbols`).',
        shape=_POSITION,))
def lsp_find_definition(
    relative_path: Annotated[str, RELATIVE_PATH],
    line: Annotated[int, '1-based line'],
    character: Annotated[int, '1-based column'],
) -> str:

    try:
        rel, server = _require_lsp_read_path(relative_path)
        manager = _agent_manager(server)
        manager.sync_for_agent(rel, encoding=_default_encoding())
        result = manager.definition(rel, int(line), int(character))
        return f'Definition locations for `{rel}` at {line}:{character}:\n{_format_locations(manager, result)}'
    except Exception as exc:
        srv = lsp_server_for_path(normalize_relative_posix_path(relative_path))
        return _format_lsp_tool_error('definition lookup', exc, relative_path=relative_path, server=srv)


@tool(LSP_REFERENCES_NAME, description=describe('Find references for the symbol at a line/character position.',
        when='tracing usages or impact of a symbol.',
        not_='text grep across the repo (use `search_workspace`).',
        shape=f'{_POSITION}; `include_declaration` adds the definition site',))
def lsp_find_references(
    relative_path: Annotated[str, RELATIVE_PATH],
    line: Annotated[int, '1-based line'],
    character: Annotated[int, '1-based column'],
    include_declaration: Annotated[bool, 'also list the definition site'] = False,
) -> str:

    try:
        rel, server = _require_lsp_read_path(relative_path)
        manager = _agent_manager(server)
        manager.sync_for_agent(rel, encoding=_default_encoding())
        result = manager.references(rel, int(line), int(character), include_declaration=bool(include_declaration))
        return f'References for `{rel}` at {line}:{character}:\n{_format_locations(manager, result)}'
    except Exception as exc:
        srv = lsp_server_for_path(normalize_relative_posix_path(relative_path))
        return _format_lsp_tool_error('reference lookup', exc, relative_path=relative_path, server=srv)


@tool(LSP_DOCUMENT_SYMBOLS_NAME, description=describe(
    'List document symbols for a file using the active LSP session.',
    when='need a structural outline before reading or editing.',
    not_='cross-file search (use `search_workspace` or `lsp_find_references`).',
    shape=_LSP_EXTENSIONS,
))
def lsp_get_document_symbols(relative_path: Annotated[str, RELATIVE_PATH]) -> str:

    try:
        rel, server = _require_lsp_read_path(relative_path)
        manager = _agent_manager(server)
        manager.sync_for_agent(rel, encoding=_default_encoding())
        symbols = manager.document_symbols(rel)
        lines = _format_symbols(symbols)
        if not lines:
            return f'No document symbols for `{rel}`.'
        return f'Document symbols for `{rel}`:\n' + '\n'.join(lines[:200])
    except Exception as exc:
        srv = lsp_server_for_path(normalize_relative_posix_path(relative_path))
        return _format_lsp_tool_error('document symbol lookup', exc, relative_path=relative_path, server=srv)


LSP_READ_TOOLS: list[Any] = [
    lsp_get_diagnostics,
    lsp_hover,
    lsp_find_definition,
    lsp_find_references,
    lsp_get_document_symbols,
]
