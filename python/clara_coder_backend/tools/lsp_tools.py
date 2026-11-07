"""LangChain tools for LSP context and diagnostics (edits go through :mod:`clara_coder_backend.tools.edit`)."""

from __future__ import annotations

from typing import Annotated, Any

from langchain_core.tools import tool

from clara_coder_backend.lsp.diagnostics import (
    diagnostics_pending_note,
    diagnostics_session_aggregate_preamble,
    format_diagnostics_summary,
)
from clara_coder_backend.lsp.editor_features import run_editor_feature, workspace_symbols
from clara_coder_backend.lsp.file_policy import lsp_server_for_path, normalize_relative_posix_path
from clara_coder_backend.lsp.manager import (
    LspServerKind,
    diagnostics_cache_for_scope,
    get_session_lsp_manager,
    notify_session_lsp_disk_changes,
)
from clara_coder_backend.lsp.registry import display_label_for_server
from clara_coder_backend.runtime.python_env import resolve_python_workspace_root
from clara_coder_backend.tools.tool_conventions import RELATIVE_PATH, describe
from clara_coder_backend.session.state import current_session_id, get_session, runtime_config
from clara_coder_backend.workspace.workspace_text_io import validate_workspace_encoding

LSP_GET_DIAGNOSTICS_NAME = 'lsp_get_diagnostics'
LSP_HOVER_NAME = 'lsp_hover'
LSP_DEFINITION_NAME = 'lsp_find_definition'
LSP_REFERENCES_NAME = 'lsp_find_references'
LSP_DOCUMENT_SYMBOLS_NAME = 'lsp_get_document_symbols'
LSP_IMPLEMENTATIONS_NAME = 'lsp_find_implementations'
LSP_WORKSPACE_SYMBOLS_NAME = 'lsp_workspace_symbols'
LSP_CALL_HIERARCHY_NAME = 'lsp_call_hierarchy'
LSP_TYPE_HIERARCHY_NAME = 'lsp_type_hierarchy'

__all__ = [
    'LSP_GET_DIAGNOSTICS_NAME',
    'LSP_HOVER_NAME',
    'LSP_DEFINITION_NAME',
    'LSP_REFERENCES_NAME',
    'LSP_DOCUMENT_SYMBOLS_NAME',
    'LSP_IMPLEMENTATIONS_NAME',
    'LSP_WORKSPACE_SYMBOLS_NAME',
    'LSP_CALL_HIERARCHY_NAME',
    'LSP_TYPE_HIERARCHY_NAME',
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
    off_reason = manager.diagnostics_off_reason(relative_path)
    if off_reason:
        text += f'\n\nNote: {off_reason}'
    elif not manager.diagnostics_fresh(relative_path):
        text += '\n\n' + diagnostics_pending_note(server)
    return text


#: How long one all-files call waits for basedpyright's whole-workspace scan before answering with
#: what it has so far. A later call waits again.
_PYTHON_WORKSPACE_ANALYSIS_TIMEOUT_S = 60.0


def _python_workspace_coverage(session_id: str) -> str:
    """Say how much of a Python workspace the cached diagnostics cover; '' for non-Python workspaces.

    With Settings → LSP → Python set to check the whole workspace, basedpyright is started here
    (an all-files call must not depend on a ``.py`` file having been opened first) and its scan
    awaited, so files nobody opened are included.
    """

    try:
        manager = get_session_lsp_manager(session_id, server='python', scope='workspace', set_active=False)
        if resolve_python_workspace_root(manager.workspace_root)[0] is None:
            return ''
    except Exception:
        return ''
    if runtime_config.lsp.python.diagnostic_mode != 'workspace':
        return (
            'Python coverage: only files opened in this session are analyzed; Python files that were '
            'never opened are not listed.'
        )
    try:
        settled = manager.wait_for_workspace_analysis(timeout_s=_PYTHON_WORKSPACE_ANALYSIS_TIMEOUT_S)
    except Exception as exc:
        return f'Python coverage: basedpyright could not start ({exc}); Python files are not included.'
    if settled:
        return 'Python coverage: basedpyright analyzed the whole workspace, including files never opened.'
    if not manager.is_client_running():
        return (
            'Python coverage: basedpyright stopped before it finished analyzing the workspace, so the '
            'Python results are partial. Call again to restart it.'
        )
    progress = manager.analysis_progress_report()
    detail = f' ({progress})' if progress else ''
    return (
        f'Python coverage: basedpyright is still analyzing the workspace{detail}, so the Python results '
        'are partial. Call again to wait for the rest.'
    )


def _aggregate_cached_diagnostics(session_id: str, encoding: str = 'utf-8') -> str:
    notify_session_lsp_disk_changes(session_id, ['.'], ['unknown'], encoding=encoding)
    python_coverage = _python_workspace_coverage(session_id)
    cache = diagnostics_cache_for_scope(get_session(session_id), 'workspace')
    all_rows: list[dict[str, Any]] = []
    for path in sorted(cache):
        all_rows.extend(cache[path])
    if not all_rows:
        empty = 'No cached LSP diagnostics are available.'
        return f'{empty}\n\n{python_coverage}' if python_coverage else empty
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
    if python_coverage:
        lines.extend(['', python_coverage])
    return '\n'.join(lines)


_LSP_EXTENSIONS = '`.py`, `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs`, `.gd`, `.java`'
_POSITION = f'1-based `line`/`character`; {_LSP_EXTENSIONS}'
_NAMED_LOCATION_LIMIT = 50


@tool(LSP_GET_DIAGNOSTICS_NAME, description=describe(
    'Return LSP diagnostics for one file, or every cached diagnostic when `relative_path` is empty '
    '(the result says whether Python files never opened are included)',
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


def _format_named_locations(rows: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for row in rows[:_NAMED_LOCATION_LIMIT]:
        rng = row.get('range') or {}
        where = f"`{row.get('relativePath')}` {rng.get('startLineNumber')}:{rng.get('startColumn')}"
        name = str(row.get('name') or '')
        container = str(row.get('containerName') or row.get('detail') or '')
        label = f'{name} ({container})' if name and container else name
        lines.append(f'- {label}: {where}' if label else f'- {where}')
    if len(rows) > _NAMED_LOCATION_LIMIT:
        lines.append(f'... {len(rows) - _NAMED_LOCATION_LIMIT} more omitted.')
    return '\n'.join(lines)


def _feature_lookup(
    relative_path: str,
    line: int,
    character: int,
    *,
    feature: str,
    provider: str,
    title: str,
    params: dict[str, Any] | None = None,
) -> str:
    rel, server = _require_lsp_read_path(relative_path)
    manager = _agent_manager(server)
    manager.sync_for_agent(rel, encoding=_default_encoding())
    payload = run_editor_feature(manager, rel, feature, {'line': line, 'character': character, **(params or {})})
    rows = payload.get('locations') or []
    if rows:
        return f'{title} for `{rel}` at {line}:{character}:\n{_format_named_locations(rows)}'
    if not manager.has_provider(provider):
        return f'The {server} language server does not support this lookup.'
    return f'{title}: nothing found for `{rel}` at {line}:{character}.'


@tool(LSP_IMPLEMENTATIONS_NAME, description=describe(
    'Find implementations or overrides of the symbol at a line/character position.',
    when='finding which subclasses override a method or implement an interface.',
    not_='plain usages (use `lsp_find_references`).',
    shape=_POSITION,
))
def lsp_find_implementations(
    relative_path: Annotated[str, RELATIVE_PATH],
    line: Annotated[int, '1-based line'],
    character: Annotated[int, '1-based column'],
) -> str:

    try:
        return _feature_lookup(
            relative_path,
            int(line),
            int(character),
            feature='implementation',
            provider='implementationProvider',
            title='Implementations',
        )
    except Exception as exc:
        srv = lsp_server_for_path(normalize_relative_posix_path(relative_path))
        return _format_lsp_tool_error('implementation lookup', exc, relative_path=relative_path, server=srv)


@tool(LSP_CALL_HIERARCHY_NAME, description=describe(
    'List the direct callers or callees of the function at a line/character position.',
    when='tracing who calls a function or what it calls, one level at a time.',
    not_='every textual usage (use `lsp_find_references`).',
    shape=f'{_POSITION}; `direction` is `incoming` (callers) or `outgoing` (callees)',
))
def lsp_call_hierarchy(
    relative_path: Annotated[str, RELATIVE_PATH],
    line: Annotated[int, '1-based line'],
    character: Annotated[int, '1-based column'],
    direction: Annotated[str, '`incoming` = callers, `outgoing` = callees'] = 'incoming',
) -> str:

    try:
        outgoing = (direction or '').strip().lower() == 'outgoing'
        return _feature_lookup(
            relative_path,
            int(line),
            int(character),
            feature='callHierarchy',
            provider='callHierarchyProvider',
            title='Callees' if outgoing else 'Callers',
            params={'direction': 'outgoing' if outgoing else 'incoming'},
        )
    except Exception as exc:
        srv = lsp_server_for_path(normalize_relative_posix_path(relative_path))
        return _format_lsp_tool_error('call hierarchy lookup', exc, relative_path=relative_path, server=srv)


@tool(LSP_TYPE_HIERARCHY_NAME, description=describe(
    'List the direct supertypes or subtypes of the class at a line/character position.',
    when='walking a class inheritance tree.',
    shape=f'{_POSITION}; `direction` is `supertypes` or `subtypes`',
))
def lsp_type_hierarchy(
    relative_path: Annotated[str, RELATIVE_PATH],
    line: Annotated[int, '1-based line'],
    character: Annotated[int, '1-based column'],
    direction: Annotated[str, '`supertypes` or `subtypes`'] = 'supertypes',
) -> str:

    try:
        subtypes = (direction or '').strip().lower() == 'subtypes'
        return _feature_lookup(
            relative_path,
            int(line),
            int(character),
            feature='typeHierarchy',
            provider='typeHierarchyProvider',
            title='Subtypes' if subtypes else 'Supertypes',
            params={'direction': 'subtypes' if subtypes else 'supertypes'},
        )
    except Exception as exc:
        srv = lsp_server_for_path(normalize_relative_posix_path(relative_path))
        return _format_lsp_tool_error('type hierarchy lookup', exc, relative_path=relative_path, server=srv)


@tool(LSP_WORKSPACE_SYMBOLS_NAME, description=describe(
    'Find classes, functions and other symbols by name across the workspace.',
    when='you know a symbol name but not which file declares it.',
    not_='free-text search (use `search_workspace`).',
    shape='`relative_path` is any file in the target language and picks the language server',
))
def lsp_workspace_symbols(
    relative_path: Annotated[str, f'{RELATIVE_PATH}; any file in the target language'],
    query: Annotated[str, 'symbol name or part of it'],
) -> str:

    try:
        _rel, server = _require_lsp_read_path(relative_path)
        manager = _agent_manager(server)
        rows = workspace_symbols(manager, str(query or ''))
        if rows:
            return f'Workspace symbols matching `{query}`:\n{_format_named_locations(rows)}'
        if not manager.has_provider('workspaceSymbolProvider'):
            return f'The {server} language server does not support workspace symbols.'
        return f'No workspace symbols match `{query}`.'
    except Exception as exc:
        srv = lsp_server_for_path(normalize_relative_posix_path(relative_path))
        return _format_lsp_tool_error('workspace symbol lookup', exc, relative_path=relative_path, server=srv)


LSP_READ_TOOLS: list[Any] = [
    lsp_get_diagnostics,
    lsp_hover,
    lsp_find_definition,
    lsp_find_references,
    lsp_get_document_symbols,
    lsp_find_implementations,
    lsp_call_hierarchy,
    lsp_type_hierarchy,
    lsp_workspace_symbols,
]
