"""LangChain tools for LSP context, diagnostics, and language-specific CRUD helpers."""

from __future__ import annotations

from collections.abc import Callable
from typing import Annotated, Any

from langchain_core.tools import tool

from clara_coder_backend.tools.delete import delete_workspace_entry
from clara_coder_backend.lsp.diagnostics import diagnostics_session_aggregate_preamble, format_diagnostics_summary
from clara_coder_backend.lsp.file_policy import (
    get_gdscript_lsp_policy,
    get_java_lsp_policy,
    get_python_lsp_policy,
    get_typescript_lsp_policy,
    lsp_server_for_path,
    normalize_relative_posix_path,
    suggest_edit_tool_for_path,
)
from clara_coder_backend.lsp.manager import (
    LspServerKind,
    activate_session_lsp_scope,
    diagnostics_cache_for_scope,
    get_session_lsp_manager,
)
from clara_coder_backend.lsp.registry import display_label_for_server
from clara_coder_backend.tools.edit import apply_workspace_full_file
from clara_coder_backend.tools.staging_edit import stage_create_file, stage_workspace_file_overwrite
from clara_coder_backend.tools.tool_conventions import (
    ENCODING_NEWLINE,
    RELATIVE_PATH,
    STAGE_LAND,
    VERIFY_LSP,
    describe,
)
from clara_coder_backend.session.state import current_session_id, direct_workspace_edits_active, get_session
from clara_coder_backend.workspace.workspace_text_io import validate_workspace_encoding

LSP_GET_DIAGNOSTICS_NAME = 'lsp_get_diagnostics'
LSP_HOVER_NAME = 'lsp_hover'
LSP_DEFINITION_NAME = 'lsp_find_definition'
LSP_REFERENCES_NAME = 'lsp_find_references'
LSP_DOCUMENT_SYMBOLS_NAME = 'lsp_get_document_symbols'
LSP_CREATE_PYTHON_FILE_NAME = 'lsp_create_python_file'
LSP_UPDATE_PYTHON_FILE_NAME = 'lsp_update_python_file'
LSP_DELETE_PYTHON_FILE_NAME = 'lsp_delete_python_file'
LSP_CREATE_TYPESCRIPT_FILE_NAME = 'lsp_create_typescript_file'
LSP_UPDATE_TYPESCRIPT_FILE_NAME = 'lsp_update_typescript_file'
LSP_DELETE_TYPESCRIPT_FILE_NAME = 'lsp_delete_typescript_file'
LSP_CREATE_GDSCRIPT_FILE_NAME = 'lsp_create_gdscript_file'
LSP_UPDATE_GDSCRIPT_FILE_NAME = 'lsp_update_gdscript_file'
LSP_DELETE_GDSCRIPT_FILE_NAME = 'lsp_delete_gdscript_file'
LSP_CREATE_JAVA_FILE_NAME = 'lsp_create_java_file'
LSP_UPDATE_JAVA_FILE_NAME = 'lsp_update_java_file'
LSP_DELETE_JAVA_FILE_NAME = 'lsp_delete_java_file'

__all__ = [
    'LSP_GET_DIAGNOSTICS_NAME',
    'LSP_HOVER_NAME',
    'LSP_DEFINITION_NAME',
    'LSP_REFERENCES_NAME',
    'LSP_DOCUMENT_SYMBOLS_NAME',
    'LSP_CREATE_PYTHON_FILE_NAME',
    'LSP_UPDATE_PYTHON_FILE_NAME',
    'LSP_DELETE_PYTHON_FILE_NAME',
    'LSP_CREATE_TYPESCRIPT_FILE_NAME',
    'LSP_UPDATE_TYPESCRIPT_FILE_NAME',
    'LSP_DELETE_TYPESCRIPT_FILE_NAME',
    'LSP_CREATE_GDSCRIPT_FILE_NAME',
    'LSP_UPDATE_GDSCRIPT_FILE_NAME',
    'LSP_DELETE_GDSCRIPT_FILE_NAME',
    'LSP_CREATE_JAVA_FILE_NAME',
    'LSP_UPDATE_JAVA_FILE_NAME',
    'LSP_DELETE_JAVA_FILE_NAME',
    'LSP_READ_TOOLS',
    'LSP_MUTATION_TOOLS',
    'LSP_REVIEW_TOOLS',
]


def _require_python_path(relative_path: str) -> str:
    rel = normalize_relative_posix_path(relative_path)
    if get_python_lsp_policy(rel) is None:
        raise ValueError(f'Python LSP mutation tools only support `.py` files. Got `{rel}`.')
    return rel


def _require_typescript_path(relative_path: str) -> str:
    rel = normalize_relative_posix_path(relative_path)
    if get_typescript_lsp_policy(rel) is None:
        raise ValueError(
            f'TypeScript/JavaScript LSP mutation tools only support `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, and `.cjs` '
            f'files. Got `{rel}`.'
        )
    return rel


def _require_gdscript_path(relative_path: str) -> str:
    rel = normalize_relative_posix_path(relative_path)
    if get_gdscript_lsp_policy(rel) is None:
        raise ValueError(f'GDScript LSP mutation tools only support `.gd` files. Got `{rel}`.')
    return rel


def _require_java_path(relative_path: str) -> str:
    rel = normalize_relative_posix_path(relative_path)
    if get_java_lsp_policy(rel) is None:
        raise ValueError(f'Java LSP mutation tools only support `.java` files. Got `{rel}`.')
    return rel


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
    elif 'only support' in lowered and rel:
        message += f' To edit this path, retry with the appropriate tool: {suggest_edit_tool_for_path(rel)}'
    return message


def _format_lsp_mutation_path_error(exc: ValueError, *, relative_path: str) -> str:
    rel = normalize_relative_posix_path(relative_path)
    detail = ' '.join(str(exc).strip().split()) or exc.__class__.__name__
    return (
        f'Tool error: {detail} '
        f'Retry with the appropriate tool: {suggest_edit_tool_for_path(rel)}'
    )


def _run_lsp_mutation_tool(
    tool_obj: Any,
    payload: dict[str, Any],
    *,
    relative_path: str,
    path_guard: Callable[[str], str],
    language_label: str,
) -> str:
    try:
        rel = path_guard(relative_path)
    except ValueError as exc:
        return _format_lsp_mutation_path_error(exc, relative_path=relative_path)
    sid = (current_session_id.get() or '').strip()
    session = get_session(sid) if sid else None
    direct = bool(
        session
        and session.worker_apply_mode
        and direct_workspace_edits_active(session, apply_mode=True)
    )
    if sid:
        activate_session_lsp_scope(sid, scope='workspace' if direct else 'staging')
    result = tool_obj.invoke(payload)
    result_text = result if isinstance(result, str) else str(result)
    if result_text.lower().startswith('tool error:'):
        return result_text
    scope_label = 'workspace' if direct else 'staging'
    return f'{language_label} LSP {scope_label} path selected for `{rel}`.\n\n{result_text}'


def _lsp_create_file_impl(
    relative_path: str,
    new_content: str,
    encoding: str,
    newline: str,
    land_in_workspace: bool,
    *,
    path_guard: Callable[[str], str],
    language_label: str,
) -> str:
    sid = (current_session_id.get() or '').strip()
    session = get_session(sid) if sid else None
    payload = {
        'relative_path': relative_path,
        'new_content': new_content,
        'encoding': encoding,
        'newline': newline,
    }
    if session and session.worker_apply_mode and direct_workspace_edits_active(session, apply_mode=True):
        return _run_lsp_mutation_tool(
            apply_workspace_full_file,
            payload,
            relative_path=relative_path,
            path_guard=path_guard,
            language_label=language_label,
        )
    return _run_lsp_mutation_tool(
        stage_create_file,
        {**payload, 'land_in_workspace': land_in_workspace},
        relative_path=relative_path,
        path_guard=path_guard,
        language_label=language_label,
    )


def _lsp_update_file_impl(
    relative_path: str,
    new_content: str,
    encoding: str,
    newline: str,
    land_in_workspace: bool,
    *,
    path_guard: Callable[[str], str],
    language_label: str,
) -> str:
    sid = (current_session_id.get() or '').strip()
    session = get_session(sid) if sid else None
    payload = {
        'relative_path': relative_path,
        'new_content': new_content,
        'encoding': encoding,
        'newline': newline,
    }
    if session and session.worker_apply_mode and direct_workspace_edits_active(session, apply_mode=True):
        return _run_lsp_mutation_tool(
            apply_workspace_full_file,
            payload,
            relative_path=relative_path,
            path_guard=path_guard,
            language_label=language_label,
        )
    return _run_lsp_mutation_tool(
        stage_workspace_file_overwrite,
        {**payload, 'land_in_workspace': land_in_workspace},
        relative_path=relative_path,
        path_guard=path_guard,
        language_label=language_label,
    )


def _sync_active_document_for_diagnostics(
    relative_path: str,
    *,
    encoding: str,
    server: LspServerKind,
    scope: str,
) -> tuple[list[dict[str, Any]], str]:
    manager = get_session_lsp_manager(
        server=server,
        scope='workspace' if scope == 'staging' else scope,
        set_active=False,
    )
    rows = manager.sync_workspace_document(relative_path, encoding=encoding)
    analyzed = 'workspace_file'
    return rows, analyzed


def _session_lsp_scope_label(session_id: str | None) -> str:
    sid = (session_id or '').strip()
    if not sid:
        return 'workspace'
    return str(get_session(sid).lsp_active_scope or 'workspace')


def _resolve_diagnostics_scopes(requested: str, session_id: str | None) -> list[str]:
    value = (requested or '').strip().lower()
    if not value:
        return [_session_lsp_scope_label(session_id)]
    if value == 'both':
        return ['staging', 'workspace']
    if value in ('workspace', 'staging'):
        return [value]
    raise ValueError(
        f'Unsupported LSP diagnostics scope: {requested!r}. Use `workspace`, `staging`, `both`, or omit for the session default.'
    )


def _diagnostics_for_scope(
    *,
    relative_path: str,
    server: LspServerKind,
    scope: str,
    encoding: str,
    refresh_active_document: bool,
) -> str:
    manager = get_session_lsp_manager(
        server=server,
        scope='workspace' if scope == 'staging' else scope,
        set_active=False,
    )
    cached_items = manager.get_diagnostics(relative_path)
    analyzed_source = 'cached'
    if refresh_active_document or not cached_items:
        try:
            _, analyzed_source = _sync_active_document_for_diagnostics(
                relative_path,
                encoding=encoding,
                server=server,
                scope=scope,
            )
        except Exception as exc:
            if cached_items:
                return (
                    format_diagnostics_summary(
                        relative_path,
                        cached_items,
                        lsp_scope=scope,
                        analyzed_source='cached',
                        server_kind=server,
                    )
                    + f'\n\nNote: {_lsp_server_label(server)} LSP refresh failed ({exc}).'
                )
            raise
    final_items = manager.get_diagnostics(relative_path)
    return format_diagnostics_summary(
        relative_path,
        final_items,
        lsp_scope=scope,
        analyzed_source=analyzed_source,
        server_kind=server,
    )


def _aggregate_cached_diagnostics(session_id: str, scopes: list[str]) -> str:
    session = get_session(session_id)
    blocks: list[str] = []
    for scope in scopes:
        cache = diagnostics_cache_for_scope(session, scope)
        all_rows: list[dict[str, Any]] = []
        for path in sorted(cache):
            all_rows.extend(cache[path])
        if not all_rows:
            blocks.append(
                f'{diagnostics_session_aggregate_preamble(scope)}\n'
                f'No cached LSP diagnostics for scope={scope}.'
            )
            continue
        lines = [
            diagnostics_session_aggregate_preamble(scope),
            f'Cached LSP diagnostics ({len(all_rows)} issue(s)):',
        ]
        for item in all_rows[:100]:
            lines.append(
                f"- `{item['relative_path']}` {item['line']}:{item['character']} [{item['severity']}] {item['message']}"
            )
        if len(all_rows) > 100:
            lines.append(f'... {len(all_rows) - 100} more diagnostic(s) omitted.')
        blocks.append('\n'.join(lines))
    if len(blocks) == 1 and blocks[0].endswith(f'No cached LSP diagnostics for scope={scopes[0]}.'):
        return 'No cached LSP diagnostics are available.'
    return '\n\n'.join(blocks)


@tool(LSP_GET_DIAGNOSTICS_NAME, description=describe('Return cached LSP diagnostics for one file, or all cached diagnostics when no path is given.',
        when='checking errors after edits or auditing workspace health.',
        not_='mutating files (use LSP mutators or staging tools).',
        shape=(
            '`.py`, `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.gd`, `.java`; empty path = all cached. '
            '`scope` is `workspace`, `staging`, `both`, or empty (session default). Staging scope uses the '
            'same real workspace as workspace scope (write-through drafts are already on disk). '
            '`refresh_active_document=true` re-syncs the on-disk file first.'
        ),
        verify=(
            'after `format_staging_file_black` on a staged `.py` path, or `format_staging_file_prettier` '
            'on a staged `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs`/`.html`/`.htm`/`.css` path, call with '
            '`refresh_active_document=true` on that path (LSP applies to Python, TS/JS, '
            'GDScript, and Java) to verify indentation-related diagnostics are gone where the server supports it.'
        ),))
def lsp_get_diagnostics(
    relative_path: Annotated[str, 'workspace-relative POSIX path'] = '',
    refresh_active_document: bool = False,
    encoding: Annotated[str, 'empty = Settings default'] = '',
    scope: Annotated[str, '`workspace` | `staging` | `both` | empty = session default'] = '',
) -> str:

    enc = validate_workspace_encoding((encoding or '').strip() or 'utf-8')
    rel = normalize_relative_posix_path(relative_path)
    try:
        sid_tool = (current_session_id.get() or '').strip()
        scopes = _resolve_diagnostics_scopes(scope, sid_tool)
        if rel:
            rel2, server = _require_lsp_read_path(rel)
            refresh = bool(refresh_active_document)
            if not refresh and sid_tool:
                session = get_session(sid_tool)
                pending = getattr(session, 'pending_edit_stagings', None)
                if isinstance(pending, dict):
                    entry = pending.get(rel2)
                    if entry is not None and not getattr(entry, 'workspace_applied', False):
                        refresh = True
            parts = [
                _diagnostics_for_scope(
                    relative_path=rel2,
                    server=server,
                    scope=scope_label,
                    encoding=enc,
                    refresh_active_document=refresh,
                )
                for scope_label in scopes
            ]
            return '\n\n'.join(parts)

        if not sid_tool:
            return 'No cached LSP diagnostics are available.'
        return _aggregate_cached_diagnostics(sid_tool, scopes)
    except Exception as exc:
        srv = lsp_server_for_path(rel) if rel else None
        return _format_lsp_tool_error('diagnostics lookup', exc, relative_path=rel, server=srv)


@tool(LSP_HOVER_NAME, description=describe('Resolve LSP hover information at a line/character position.',
        when='need type docs or quick symbol context at cursor.',
        not_='whole-file reads (use `read_workspace_file`).',
        shape=f'Python or TS/JS; 1-based line/character; `relative_path` {RELATIVE_PATH}.',))
def lsp_hover(
    relative_path: Annotated[str, 'workspace-relative POSIX path'],
    line: int,
    character: int,
) -> str:

    try:
        rel, server = _require_lsp_read_path(relative_path)
        manager = get_session_lsp_manager(server=server)
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
        shape=f'Python or TS/JS; 1-based line/character; `relative_path` {RELATIVE_PATH}.',))
def lsp_find_definition(
    relative_path: Annotated[str, 'workspace-relative POSIX path'],
    line: int,
    character: int,
) -> str:

    try:
        rel, server = _require_lsp_read_path(relative_path)
        manager = get_session_lsp_manager(server=server)
        result = manager.definition(rel, int(line), int(character))
        return f'Definition locations for `{rel}` at {line}:{character}:\n{_format_locations(manager, result)}'
    except Exception as exc:
        srv = lsp_server_for_path(normalize_relative_posix_path(relative_path))
        return _format_lsp_tool_error('definition lookup', exc, relative_path=relative_path, server=srv)


@tool(LSP_REFERENCES_NAME, description=describe('Find references for the symbol at a line/character position.',
        when='tracing usages or impact of a symbol.',
        not_='text grep across the repo (use `search_workspace`).',
        shape=f'Python or TS/JS; 1-based line/character; `include_declaration` adds the definition site; `relative_path` {RELATIVE_PATH}.',))
def lsp_find_references(
    relative_path: Annotated[str, 'workspace-relative POSIX path'],
    line: int,
    character: int,
    include_declaration: bool = False,
) -> str:

    try:
        rel, server = _require_lsp_read_path(relative_path)
        manager = get_session_lsp_manager(server=server)
        result = manager.references(rel, int(line), int(character), include_declaration=bool(include_declaration))
        return f'References for `{rel}` at {line}:{character}:\n{_format_locations(manager, result)}'
    except Exception as exc:
        srv = lsp_server_for_path(normalize_relative_posix_path(relative_path))
        return _format_lsp_tool_error('reference lookup', exc, relative_path=relative_path, server=srv)


@tool(LSP_DOCUMENT_SYMBOLS_NAME, description=describe(
    'List document symbols for a file using the active LSP session.',
    when='need a structural outline before reading or editing.',
    not_='cross-file search (use `search_workspace` or `lsp_find_references`).',
    shape=f'Python or TS/JS; `relative_path` {RELATIVE_PATH}.',
))
def lsp_get_document_symbols(relative_path: Annotated[str, 'workspace-relative POSIX path']) -> str:

    try:
        rel, server = _require_lsp_read_path(relative_path)
        manager = get_session_lsp_manager(server=server)
        symbols = manager.document_symbols(rel)
        lines = _format_symbols(symbols)
        if not lines:
            return f'No document symbols for `{rel}`.'
        return f'Document symbols for `{rel}`:\n' + '\n'.join(lines[:200])
    except Exception as exc:
        srv = lsp_server_for_path(normalize_relative_posix_path(relative_path))
        return _format_lsp_tool_error('document symbol lookup', exc, relative_path=relative_path, server=srv)


@tool(LSP_CREATE_PYTHON_FILE_NAME, description=describe('Create or whole-file rewrite a `.py` file via staging and code review (like `stage_create_file`).',
        when='new Python file or full rewrite.',
        not_='partial edits (use staged line-range tools).',
        shape=f'.py only; nested dirs OK; full `new_content`; {ENCODING_NEWLINE}; {STAGE_LAND}.',
        verify=VERIFY_LSP,))
def lsp_create_python_file(
    relative_path: Annotated[str, 'workspace-relative POSIX path'],
    new_content: str,
    encoding: Annotated[str, 'empty = Settings default'] = '',
    newline: str = '',
    land_in_workspace: Annotated[bool, 'false while iterating; true on final call to land in one step'] = False,
) -> str:

    return _lsp_create_file_impl(
        relative_path,
        new_content,
        encoding,
        newline,
        land_in_workspace,
        path_guard=_require_python_path,
        language_label='Python',
    )


@tool(LSP_UPDATE_PYTHON_FILE_NAME, description=describe('Overwrite an existing `.py` file (or pending staged draft) with full updated text via staging and code review (like `stage_workspace_file_overwrite`).',
        when='whole-file Python rewrite when file already exists.',
        not_='partial edits (use staged line-range tools).',
        shape=f'.py only; full `new_content`; {ENCODING_NEWLINE}; {STAGE_LAND}.',
        verify=VERIFY_LSP,))
def lsp_update_python_file(
    relative_path: Annotated[str, 'workspace-relative POSIX path'],
    new_content: str,
    encoding: Annotated[str, 'empty = Settings default'] = '',
    newline: str = '',
    land_in_workspace: Annotated[bool, 'false while iterating; true on final call to land in one step'] = False,
) -> str:

    return _lsp_update_file_impl(
        relative_path,
        new_content,
        encoding,
        newline,
        land_in_workspace,
        path_guard=_require_python_path,
        language_label='Python',
    )


@tool(LSP_DELETE_PYTHON_FILE_NAME, description=describe(
    'Remove a `.py` file from the workspace; clears LSP state for that document.',
    when='file should be deleted entirely.',
    not_='partial content removal (use update or line-range tools).',
    shape=f'.py only; `relative_path` {RELATIVE_PATH}.',
))
def lsp_delete_python_file(relative_path: Annotated[str, 'workspace-relative POSIX path']) -> str:

    try:
        _require_python_path(relative_path)
    except ValueError as exc:
        return _format_lsp_mutation_path_error(exc, relative_path=relative_path)
    return delete_workspace_entry.invoke({'relative_path': relative_path})


@tool(LSP_CREATE_TYPESCRIPT_FILE_NAME, description=describe('Create or whole-file rewrite a TS/JS file via staging and code review (like `stage_create_file`).',
        when='new `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, or `.cjs` file or full rewrite.',
        not_='partial edits (use staged line-range tools).',
        shape=(
            f'.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` only; nested dirs OK; full `new_content`; '
            f'{ENCODING_NEWLINE}; on staged drafts use `format_staging_file_prettier` before LSP refresh when formatting is needed; {STAGE_LAND}.'
        ),
        verify=VERIFY_LSP,))
def lsp_create_typescript_file(
    relative_path: Annotated[str, 'workspace-relative POSIX path'],
    new_content: str,
    encoding: Annotated[str, 'empty = Settings default'] = '',
    newline: str = '',
    land_in_workspace: Annotated[bool, 'false while iterating; true on final call to land in one step'] = False,
) -> str:

    return _lsp_create_file_impl(
        relative_path,
        new_content,
        encoding,
        newline,
        land_in_workspace,
        path_guard=_require_typescript_path,
        language_label='TypeScript/JavaScript',
    )


@tool(LSP_UPDATE_TYPESCRIPT_FILE_NAME, description=describe('Overwrite an existing TS/JS file (or pending staged draft) with full updated text via staging and code review (like `stage_workspace_file_overwrite`).',
        when='whole-file TS/JS rewrite when file already exists.',
        not_='partial edits (use staged line-range tools).',
        shape=f'.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` only; full `new_content`; {ENCODING_NEWLINE}; {STAGE_LAND}.',
        verify=VERIFY_LSP,))
def lsp_update_typescript_file(
    relative_path: Annotated[str, 'workspace-relative POSIX path'],
    new_content: str,
    encoding: Annotated[str, 'empty = Settings default'] = '',
    newline: str = '',
    land_in_workspace: Annotated[bool, 'false while iterating; true on final call to land in one step'] = False,
) -> str:

    return _lsp_update_file_impl(
        relative_path,
        new_content,
        encoding,
        newline,
        land_in_workspace,
        path_guard=_require_typescript_path,
        language_label='TypeScript/JavaScript',
    )


@tool(LSP_DELETE_TYPESCRIPT_FILE_NAME, description=describe(
    'Remove a TS/JS file from the workspace; clears LSP state for that document.',
    when='file should be deleted entirely.',
    not_='partial content removal (use update or line-range tools).',
    shape=f'.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` only; `relative_path` {RELATIVE_PATH}.',
))
def lsp_delete_typescript_file(relative_path: Annotated[str, 'workspace-relative POSIX path']) -> str:

    try:
        _require_typescript_path(relative_path)
    except ValueError as exc:
        return _format_lsp_mutation_path_error(exc, relative_path=relative_path)
    return delete_workspace_entry.invoke({'relative_path': relative_path})


@tool(LSP_CREATE_GDSCRIPT_FILE_NAME, description=describe('Create or whole-file rewrite a `.gd` file via staging and code review (like `stage_create_file`).',
        when='new GDScript file or full rewrite.',
        not_='partial edits (use staged line-range tools).',
        shape=f'.gd` only; nested dirs OK; full `new_content`; {ENCODING_NEWLINE}; {STAGE_LAND}.',
        verify=VERIFY_LSP,))
def lsp_create_gdscript_file(
    relative_path: Annotated[str, 'workspace-relative POSIX path'],
    new_content: str,
    encoding: Annotated[str, 'empty = Settings default'] = '',
    newline: str = '',
    land_in_workspace: Annotated[bool, 'false while iterating; true on final call to land in one step'] = False,
) -> str:

    return _lsp_create_file_impl(
        relative_path,
        new_content,
        encoding,
        newline,
        land_in_workspace,
        path_guard=_require_gdscript_path,
        language_label='GDScript',
    )


@tool(LSP_UPDATE_GDSCRIPT_FILE_NAME, description=describe('Overwrite an existing `.gd` file (or pending staged draft) with full updated text via staging and code review (like `stage_workspace_file_overwrite`).',
        when='whole-file GDScript rewrite when file already exists.',
        not_='partial edits (use staged line-range tools).',
        shape=f'.gd` only; full `new_content`; {ENCODING_NEWLINE}; {STAGE_LAND}.',
        verify=VERIFY_LSP,))
def lsp_update_gdscript_file(
    relative_path: Annotated[str, 'workspace-relative POSIX path'],
    new_content: str,
    encoding: Annotated[str, 'empty = Settings default'] = '',
    newline: str = '',
    land_in_workspace: Annotated[bool, 'false while iterating; true on final call to land in one step'] = False,
) -> str:

    return _lsp_update_file_impl(
        relative_path,
        new_content,
        encoding,
        newline,
        land_in_workspace,
        path_guard=_require_gdscript_path,
        language_label='GDScript',
    )


@tool(LSP_DELETE_GDSCRIPT_FILE_NAME, description=describe(
    'Remove a `.gd` file from the workspace; clears LSP state for that document.',
    when='file should be deleted entirely.',
    not_='partial content removal (use update or line-range tools).',
    shape=f'.gd` only; `relative_path` {RELATIVE_PATH}.',
))
def lsp_delete_gdscript_file(relative_path: Annotated[str, 'workspace-relative POSIX path']) -> str:

    try:
        _require_gdscript_path(relative_path)
    except ValueError as exc:
        return _format_lsp_mutation_path_error(exc, relative_path=relative_path)
    return delete_workspace_entry.invoke({'relative_path': relative_path})


@tool(LSP_CREATE_JAVA_FILE_NAME, description=describe('Create or whole-file rewrite a `.java` file via staging and code review (like `stage_create_file`).',
        when='new Java file or full rewrite.',
        not_='partial edits (use staged line-range tools).',
        shape=f'.java` only; nested dirs OK; full `new_content`; {ENCODING_NEWLINE}; {STAGE_LAND}.',
        verify=VERIFY_LSP,))
def lsp_create_java_file(
    relative_path: Annotated[str, 'workspace-relative POSIX path'],
    new_content: str,
    encoding: Annotated[str, 'empty = Settings default'] = '',
    newline: str = '',
    land_in_workspace: Annotated[bool, 'false while iterating; true on final call to land in one step'] = False,
) -> str:

    return _lsp_create_file_impl(
        relative_path,
        new_content,
        encoding,
        newline,
        land_in_workspace,
        path_guard=_require_java_path,
        language_label='Java',
    )


@tool(LSP_UPDATE_JAVA_FILE_NAME, description=describe('Overwrite an existing `.java` file (or pending staged draft) with full updated text via staging and code review (like `stage_workspace_file_overwrite`).',
        when='whole-file Java rewrite when file already exists.',
        not_='partial edits (use staged line-range tools).',
        shape=f'.java` only; full `new_content`; {ENCODING_NEWLINE}; {STAGE_LAND}.',
        verify=VERIFY_LSP,))
def lsp_update_java_file(
    relative_path: Annotated[str, 'workspace-relative POSIX path'],
    new_content: str,
    encoding: Annotated[str, 'empty = Settings default'] = '',
    newline: str = '',
    land_in_workspace: Annotated[bool, 'false while iterating; true on final call to land in one step'] = False,
) -> str:

    return _lsp_update_file_impl(
        relative_path,
        new_content,
        encoding,
        newline,
        land_in_workspace,
        path_guard=_require_java_path,
        language_label='Java',
    )


@tool(LSP_DELETE_JAVA_FILE_NAME, description=describe(
    'Remove a `.java` file from the workspace; clears LSP state for that document.',
    when='file should be deleted entirely.',
    not_='partial content removal (use update or line-range tools).',
    shape=f'.java` only; `relative_path` {RELATIVE_PATH}.',
))
def lsp_delete_java_file(relative_path: Annotated[str, 'workspace-relative POSIX path']) -> str:

    try:
        _require_java_path(relative_path)
    except ValueError as exc:
        return _format_lsp_mutation_path_error(exc, relative_path=relative_path)
    return delete_workspace_entry.invoke({'relative_path': relative_path})


LSP_READ_TOOLS: list[Any] = [
    lsp_get_diagnostics,
    lsp_hover,
    lsp_find_definition,
    lsp_find_references,
    lsp_get_document_symbols,
]

LSP_MUTATION_TOOLS: list[Any] = [
    lsp_create_python_file,
    lsp_update_python_file,
    lsp_delete_python_file,
    lsp_create_typescript_file,
    lsp_update_typescript_file,
    lsp_delete_typescript_file,
    lsp_create_gdscript_file,
    lsp_update_gdscript_file,
    lsp_delete_gdscript_file,
    lsp_create_java_file,
    lsp_update_java_file,
    lsp_delete_java_file,
]

# The code-review specialist only needs staged diagnostics visibility.
LSP_REVIEW_TOOLS: list[Any] = [
    lsp_get_diagnostics,
]
