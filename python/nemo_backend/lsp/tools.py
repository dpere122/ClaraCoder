"""LangChain tools for LSP context, diagnostics, and language-specific CRUD helpers."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from langchain_core.tools import tool

from pathlib import Path

from nemo_backend.delete_tool import delete_workspace_entry
from nemo_backend.lsp.diagnostics import diagnostics_session_aggregate_preamble, format_diagnostics_summary
from nemo_backend.lsp.file_policy import (
    get_gdscript_lsp_policy,
    get_python_lsp_policy,
    get_typescript_lsp_policy,
    lsp_server_for_path,
    normalize_relative_posix_path,
    suggest_edit_tool_for_path,
)
from nemo_backend.lsp.manager import (
    LspServerKind,
    activate_session_lsp_scope,
    get_session_lsp_manager,
)
from nemo_backend.lsp.registry import display_label_for_server
from nemo_backend.edit_tool import apply_workspace_full_file
from nemo_backend.staging_edit_tools import stage_create_file, stage_workspace_file_overwrite
from nemo_backend.state import current_session_id, direct_workspace_edits_active, get_session
from nemo_backend.workspace_text_io import validate_workspace_encoding

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
    'LSP_READ_TOOLS',
    'LSP_MUTATION_TOOLS',
    'LSP_REVIEW_TOOLS',
    # Deprecated aliases — prefer LSP_* names above.
    'PYTHON_LSP_READ_TOOLS',
    'PYTHON_LSP_MUTATION_TOOLS',
    'PYTHON_LSP_REVIEW_TOOLS',
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


def _require_lsp_read_path(relative_path: str) -> tuple[str, LspServerKind]:
    rel = normalize_relative_posix_path(relative_path)
    server = lsp_server_for_path(rel)
    if not server:
        raise ValueError(
            f'LSP read tools only support `.py`, `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, and `.gd`. Got `{rel}`.'
        )
    return rel, server


def _format_hover_contents(contents: Any) -> str:
    if isinstance(contents, str):
        return contents.strip()
    if isinstance(contents, list):
        parts = [_format_hover_contents(item) for item in contents]
        return '\n\n'.join(part for part in parts if part)
    if isinstance(contents, dict):
        value = contents.get('value')
        if value is not None:
            return str(value).strip()
        language = str(contents.get('language') or '').strip()
        text = str(contents.get('value') or contents.get('text') or '').strip()
        if language and text:
            return f'```{language}\n{text}\n```'
        return text
    return str(contents).strip()


def _workspace_rel_from_uri(manager: Any, uri: str) -> str:
    from nemo_backend.lsp.manager import _uri_to_path  # local import keeps public API small

    target = _uri_to_path(uri)
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
        or 'jedi_language_server' in lowered
        or 'typescript-language-server' in lowered
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
    relative_path: str, *, encoding: str, server: LspServerKind
) -> tuple[list[dict[str, Any]], str]:
    sid = (current_session_id.get() or '').strip()
    manager = get_session_lsp_manager(server=server)
    if getattr(manager, 'scope', 'workspace') == 'staging' and sid:
        session = get_session(sid)
        from nemo_backend.staging_test_overlay import ensure_lsp_staging_overlay

        ensure_lsp_staging_overlay(session, Path(session.workspace_path), session_id=sid)
    rows = manager.sync_workspace_document(relative_path, encoding=encoding)
    analyzed = 'overlay_workspace' if getattr(manager, 'scope', 'workspace') == 'staging' else 'workspace_file'
    return rows, analyzed


def _session_lsp_scope_label(session_id: str | None) -> str:
    sid = (session_id or '').strip()
    if not sid:
        return 'workspace'
    return str(get_session(sid).lsp_active_scope or 'workspace')


@tool(LSP_GET_DIAGNOSTICS_NAME)
def lsp_get_diagnostics(relative_path: str = '', refresh_active_document: bool = False, encoding: str = '') -> str:
    """Return cached LSP diagnostics for one file, or all cached diagnostics when no path is given.

    Works for Python (`.py`) and TypeScript/JavaScript (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`).

    Set ``refresh_active_document=true`` to re-sync before reporting diagnostics: in **workspace** scope this reads the
    on-disk file; in **staging** scope the server uses the **materialized overlay** (pending drafts on disk in a mirror
    tree) so cross-file resolution matches staged peers.
    After `format_staging_file_black` on a staged `.py` path, or `format_staging_file_prettier` on a staged
    `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs`/`.html`/`.htm`/`.css` path, call with ``refresh_active_document=true`` on that path
    (LSP applies to Python and TS/JS) to verify indentation-related diagnostics are gone where the server supports it."""

    enc = validate_workspace_encoding((encoding or '').strip() or 'utf-8')
    rel = normalize_relative_posix_path(relative_path)
    try:
        if rel:
            rel2, server = _require_lsp_read_path(rel)
            sid_tool = (current_session_id.get() or '').strip()
            scope_label = _session_lsp_scope_label(sid_tool)
            manager = get_session_lsp_manager(server=server)
            cached_items = manager.get_diagnostics(rel2)
            analyzed_source = 'cached'
            if refresh_active_document or not cached_items:
                try:
                    _, analyzed_source = _sync_active_document_for_diagnostics(rel2, encoding=enc, server=server)
                except Exception as exc:
                    if cached_items:
                        return (
                            format_diagnostics_summary(
                                rel2,
                                cached_items,
                                lsp_scope=scope_label,
                                analyzed_source='cached',
                                server_kind=server,
                            )
                            + f'\n\nNote: {_lsp_server_label(server)} LSP refresh failed ({exc}).'
                        )
                    raise
            final_items = manager.get_diagnostics(rel2)
            return format_diagnostics_summary(
                rel2,
                final_items,
                lsp_scope=scope_label,
                analyzed_source=analyzed_source,
                server_kind=server,
            )

        sid = (current_session_id.get() or '').strip()
        if not sid:
            return 'No cached LSP diagnostics are available.'
        session = get_session(sid)
        scope_label = _session_lsp_scope_label(sid)
        all_rows: list[dict[str, Any]] = []
        for path in sorted(session.lsp_diagnostics):
            all_rows.extend(session.lsp_diagnostics[path])
        if not all_rows:
            return 'No cached LSP diagnostics are available.'
        lines = [
            diagnostics_session_aggregate_preamble(scope_label),
            f'Cached LSP diagnostics ({len(all_rows)} issue(s)):',
        ]
        for item in all_rows[:100]:
            lines.append(
                f"- `{item['relative_path']}` {item['line']}:{item['character']} [{item['severity']}] {item['message']}"
            )
        if len(all_rows) > 100:
            lines.append(f'... {len(all_rows) - 100} more diagnostic(s) omitted.')
        return '\n'.join(lines)
    except Exception as exc:
        srv = lsp_server_for_path(rel) if rel else None
        return _format_lsp_tool_error('diagnostics lookup', exc, relative_path=rel, server=srv)


@tool(LSP_HOVER_NAME)
def lsp_hover(relative_path: str, line: int, character: int) -> str:
    """Resolve LSP hover information at a 1-based line/character position (Python or TS/JS files)."""

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


@tool(LSP_DEFINITION_NAME)
def lsp_find_definition(relative_path: str, line: int, character: int) -> str:
    """Find the definition location for the symbol at a 1-based line/character position (Python or TS/JS)."""

    try:
        rel, server = _require_lsp_read_path(relative_path)
        manager = get_session_lsp_manager(server=server)
        result = manager.definition(rel, int(line), int(character))
        return f'Definition locations for `{rel}` at {line}:{character}:\n{_format_locations(manager, result)}'
    except Exception as exc:
        srv = lsp_server_for_path(normalize_relative_posix_path(relative_path))
        return _format_lsp_tool_error('definition lookup', exc, relative_path=relative_path, server=srv)


@tool(LSP_REFERENCES_NAME)
def lsp_find_references(
    relative_path: str,
    line: int,
    character: int,
    include_declaration: bool = False,
) -> str:
    """Find references for the symbol at a 1-based line/character position (Python or TS/JS)."""

    try:
        rel, server = _require_lsp_read_path(relative_path)
        manager = get_session_lsp_manager(server=server)
        result = manager.references(rel, int(line), int(character), include_declaration=bool(include_declaration))
        return f'References for `{rel}` at {line}:{character}:\n{_format_locations(manager, result)}'
    except Exception as exc:
        srv = lsp_server_for_path(normalize_relative_posix_path(relative_path))
        return _format_lsp_tool_error('reference lookup', exc, relative_path=relative_path, server=srv)


@tool(LSP_DOCUMENT_SYMBOLS_NAME)
def lsp_get_document_symbols(relative_path: str) -> str:
    """List document symbols for a Python or TS/JS file using the active LSP session."""

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


@tool(LSP_CREATE_PYTHON_FILE_NAME)
def lsp_create_python_file(
    relative_path: str,
    new_content: str,
    encoding: str = '',
    newline: str = '',
    land_in_workspace: bool = False,
) -> str:
    """Use for new `.py` files or whole-file Python rewrites; routes through staging and code review like `stage_create_file`.

    Provide the full relative path (nested directories are fine). Pass complete `new_content` for the file. See `stage_create_file` for `land_in_workspace`."""

    return _lsp_create_file_impl(
        relative_path,
        new_content,
        encoding,
        newline,
        land_in_workspace,
        path_guard=_require_python_path,
        language_label='Python',
    )


@tool(LSP_UPDATE_PYTHON_FILE_NAME)
def lsp_update_python_file(
    relative_path: str,
    new_content: str,
    encoding: str = '',
    newline: str = '',
    land_in_workspace: bool = False,
) -> str:
    """Use when the Python file already exists (or has a pending staged draft); supply the full updated file text.

    Overwrites through the staged LSP-aware mutation path (code review before workspace update). See `stage_workspace_file_overwrite` for `land_in_workspace`."""

    return _lsp_update_file_impl(
        relative_path,
        new_content,
        encoding,
        newline,
        land_in_workspace,
        path_guard=_require_python_path,
        language_label='Python',
    )


@tool(LSP_DELETE_PYTHON_FILE_NAME)
def lsp_delete_python_file(relative_path: str) -> str:
    """Use to remove a `.py` file from the workspace; clears LSP state for that document."""

    try:
        _require_python_path(relative_path)
    except ValueError as exc:
        return _format_lsp_mutation_path_error(exc, relative_path=relative_path)
    return delete_workspace_entry.invoke({'relative_path': relative_path})


@tool(LSP_CREATE_TYPESCRIPT_FILE_NAME)
def lsp_create_typescript_file(
    relative_path: str,
    new_content: str,
    encoding: str = '',
    newline: str = '',
    land_in_workspace: bool = False,
) -> str:
    """Use for new `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, or `.cjs` files or whole-file rewrites; routes through staging and code review like `stage_create_file`.

    Provide the full relative path (nested directories are fine). Pass complete `new_content` for the file. On staged drafts, use `format_staging_file_prettier` before LSP refresh when formatting is needed. See `stage_create_file` for `land_in_workspace`."""

    return _lsp_create_file_impl(
        relative_path,
        new_content,
        encoding,
        newline,
        land_in_workspace,
        path_guard=_require_typescript_path,
        language_label='TypeScript/JavaScript',
    )


@tool(LSP_UPDATE_TYPESCRIPT_FILE_NAME)
def lsp_update_typescript_file(
    relative_path: str,
    new_content: str,
    encoding: str = '',
    newline: str = '',
    land_in_workspace: bool = False,
) -> str:
    """Use when a TS/JS file already exists (or has a pending staged draft); supply the full updated file text.

    Overwrites through the staged LSP-aware mutation path (code review before workspace update). See `stage_workspace_file_overwrite` for `land_in_workspace`."""

    return _lsp_update_file_impl(
        relative_path,
        new_content,
        encoding,
        newline,
        land_in_workspace,
        path_guard=_require_typescript_path,
        language_label='TypeScript/JavaScript',
    )


@tool(LSP_DELETE_TYPESCRIPT_FILE_NAME)
def lsp_delete_typescript_file(relative_path: str) -> str:
    """Use to remove a `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, or `.cjs` file from the workspace; clears LSP state for that document."""

    try:
        _require_typescript_path(relative_path)
    except ValueError as exc:
        return _format_lsp_mutation_path_error(exc, relative_path=relative_path)
    return delete_workspace_entry.invoke({'relative_path': relative_path})


@tool(LSP_CREATE_GDSCRIPT_FILE_NAME)
def lsp_create_gdscript_file(
    relative_path: str,
    new_content: str,
    encoding: str = '',
    newline: str = '',
    land_in_workspace: bool = False,
) -> str:
    """Use for new `.gd` files or whole-file GDScript rewrites; routes through staging and code review like `stage_create_file`.

    Provide the full relative path (nested directories are fine). Pass complete `new_content` for the file. See `stage_create_file` for `land_in_workspace`."""

    return _lsp_create_file_impl(
        relative_path,
        new_content,
        encoding,
        newline,
        land_in_workspace,
        path_guard=_require_gdscript_path,
        language_label='GDScript',
    )


@tool(LSP_UPDATE_GDSCRIPT_FILE_NAME)
def lsp_update_gdscript_file(
    relative_path: str,
    new_content: str,
    encoding: str = '',
    newline: str = '',
    land_in_workspace: bool = False,
) -> str:
    """Use when a GDScript file already exists (or has a pending staged draft); supply the full updated file text.

    Overwrites through the staged LSP-aware mutation path (code review before workspace update). See `stage_workspace_file_overwrite` for `land_in_workspace`."""

    return _lsp_update_file_impl(
        relative_path,
        new_content,
        encoding,
        newline,
        land_in_workspace,
        path_guard=_require_gdscript_path,
        language_label='GDScript',
    )


@tool(LSP_DELETE_GDSCRIPT_FILE_NAME)
def lsp_delete_gdscript_file(relative_path: str) -> str:
    """Use to remove a `.gd` file from the workspace; clears LSP state for that document."""

    try:
        _require_gdscript_path(relative_path)
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
]

# The code-review specialist only needs staged diagnostics visibility.
LSP_REVIEW_TOOLS: list[Any] = [
    lsp_get_diagnostics,
]

# Deprecated aliases — prefer LSP_* names above.
PYTHON_LSP_READ_TOOLS = LSP_READ_TOOLS
PYTHON_LSP_MUTATION_TOOLS = LSP_MUTATION_TOOLS
PYTHON_LSP_REVIEW_TOOLS = LSP_REVIEW_TOOLS
