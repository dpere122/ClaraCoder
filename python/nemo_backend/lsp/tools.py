"""LangChain tools for Python LSP context, diagnostics, and CRUD helpers."""

from __future__ import annotations

from typing import Any

from langchain_core.tools import tool

from nemo_backend.delete_tool import delete_workspace_entry
from nemo_backend.lsp.diagnostics import format_diagnostics_summary
from nemo_backend.lsp.file_policy import is_lsp_managed_path, normalize_relative_posix_path
from nemo_backend.lsp.manager import activate_session_lsp_scope, get_session_lsp_manager
from nemo_backend.staging_edit_tools import stage_create_file, stage_workspace_file_overwrite
from nemo_backend.state import current_session_id, get_session
from nemo_backend.workspace_text_io import validate_workspace_encoding

LSP_GET_DIAGNOSTICS_NAME = 'lsp_get_diagnostics'
LSP_HOVER_NAME = 'lsp_hover'
LSP_DEFINITION_NAME = 'lsp_find_definition'
LSP_REFERENCES_NAME = 'lsp_find_references'
LSP_DOCUMENT_SYMBOLS_NAME = 'lsp_get_document_symbols'
LSP_CREATE_PYTHON_FILE_NAME = 'lsp_create_python_file'
LSP_UPDATE_PYTHON_FILE_NAME = 'lsp_update_python_file'
LSP_DELETE_PYTHON_FILE_NAME = 'lsp_delete_python_file'

__all__ = [
    'LSP_GET_DIAGNOSTICS_NAME',
    'LSP_HOVER_NAME',
    'LSP_DEFINITION_NAME',
    'LSP_REFERENCES_NAME',
    'LSP_DOCUMENT_SYMBOLS_NAME',
    'LSP_CREATE_PYTHON_FILE_NAME',
    'LSP_UPDATE_PYTHON_FILE_NAME',
    'LSP_DELETE_PYTHON_FILE_NAME',
    'PYTHON_LSP_READ_TOOLS',
    'PYTHON_LSP_MUTATION_TOOLS',
    'PYTHON_LSP_REVIEW_TOOLS',
]


def _require_python_path(relative_path: str) -> str:
    rel = normalize_relative_posix_path(relative_path)
    if not is_lsp_managed_path(rel):
        raise ValueError(f'Python LSP tools only support `.py` files in v1. Got `{rel}`.')
    return rel


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


def _format_lsp_tool_error(action: str, exc: Exception, *, relative_path: str = '') -> str:
    rel = normalize_relative_posix_path(relative_path) if relative_path else ''
    detail = ' '.join(str(exc).strip().split()) or exc.__class__.__name__
    message = f'Tool error: Python LSP {action} failed'
    if rel:
        message += f' for `{rel}`'
    message += f' ({detail}).'
    lowered = detail.lower()
    if 'lsp client closed' in lowered or 'initialize' in lowered or 'jedi_language_server' in lowered:
        message += ' The backend Python could not start the configured language server.'
    return message


def _run_lsp_python_staging_tool(tool_obj: Any, payload: dict[str, Any], *, relative_path: str) -> str:
    rel = _require_python_path(relative_path)
    sid = (current_session_id.get() or '').strip()
    if sid:
        activate_session_lsp_scope(sid, scope='staging')
    result = tool_obj.invoke(payload)
    result_text = result if isinstance(result, str) else str(result)
    if result_text.lower().startswith('tool error:'):
        return result_text
    return f'Python LSP staging path selected for `{rel}`.\n\n{result_text}'


def _sync_active_document_for_diagnostics(manager: Any, relative_path: str, *, encoding: str) -> list[dict[str, Any]]:
    if getattr(manager, 'scope', 'workspace') == 'staging':
        sid = (current_session_id.get() or '').strip()
        if sid:
            session = get_session(sid)
            entry = session.pending_edit_stagings.get(relative_path)
            if entry is not None and not getattr(entry, 'workspace_applied', False):
                return manager.sync_document(relative_path, str(entry.merged_text))
    return manager.sync_workspace_document(relative_path, encoding=encoding)


@tool(LSP_GET_DIAGNOSTICS_NAME)
def lsp_get_diagnostics(relative_path: str = '', refresh_from_workspace: bool = False, encoding: str = '') -> str:
    """Return cached Python LSP diagnostics for one file, or all cached Python diagnostics when no path is given.

    Set `refresh_from_workspace=true` to re-sync from the active source before reporting diagnostics:
    the real workspace file in workspace scope, or the staged draft in staging scope when one exists."""

    enc = validate_workspace_encoding((encoding or '').strip() or 'utf-8')
    rel = normalize_relative_posix_path(relative_path)
    try:
        manager = get_session_lsp_manager()
        if rel:
            _require_python_path(rel)
            cached_items = manager.get_diagnostics(rel)
            if refresh_from_workspace or not cached_items:
                try:
                    _sync_active_document_for_diagnostics(manager, rel, encoding=enc)
                except Exception as exc:
                    if cached_items:
                        return (
                            format_diagnostics_summary(rel, cached_items)
                            + f'\n\nNote: Python LSP refresh failed ({exc}).'
                        )
                    raise
            return format_diagnostics_summary(rel, manager.get_diagnostics(rel))

        all_items = manager.get_diagnostics()
        if not all_items:
            return 'No cached Python LSP diagnostics are available.'
        lines = [f'Cached Python LSP diagnostics ({len(all_items)} issue(s)):']
        for item in all_items[:100]:
            lines.append(
                f"- `{item['relative_path']}` {item['line']}:{item['character']} [{item['severity']}] {item['message']}"
            )
        if len(all_items) > 100:
            lines.append(f'... {len(all_items) - 100} more diagnostic(s) omitted.')
        return '\n'.join(lines)
    except Exception as exc:
        return _format_lsp_tool_error('diagnostics lookup', exc, relative_path=rel)


@tool(LSP_HOVER_NAME)
def lsp_hover(relative_path: str, line: int, character: int) -> str:
    """Resolve Python hover information at a 1-based line/character position in a `.py` file."""

    try:
        rel = _require_python_path(relative_path)
        manager = get_session_lsp_manager()
        result = manager.hover(rel, int(line), int(character))
        contents = _format_hover_contents(result.get('contents'))
        if not contents:
            return f'No hover information for `{rel}` at {line}:{character}.'
        return f'Hover for `{rel}` at {line}:{character}:\n\n{contents}'
    except Exception as exc:
        return _format_lsp_tool_error('hover lookup', exc, relative_path=relative_path)


@tool(LSP_DEFINITION_NAME)
def lsp_find_definition(relative_path: str, line: int, character: int) -> str:
    """Find the definition location for the symbol at a 1-based line/character position in a `.py` file."""

    try:
        rel = _require_python_path(relative_path)
        manager = get_session_lsp_manager()
        result = manager.definition(rel, int(line), int(character))
        return f'Definition locations for `{rel}` at {line}:{character}:\n{_format_locations(manager, result)}'
    except Exception as exc:
        return _format_lsp_tool_error('definition lookup', exc, relative_path=relative_path)


@tool(LSP_REFERENCES_NAME)
def lsp_find_references(
    relative_path: str,
    line: int,
    character: int,
    include_declaration: bool = False,
) -> str:
    """Find Python references for the symbol at a 1-based line/character position in a `.py` file."""

    try:
        rel = _require_python_path(relative_path)
        manager = get_session_lsp_manager()
        result = manager.references(rel, int(line), int(character), include_declaration=bool(include_declaration))
        return f'References for `{rel}` at {line}:{character}:\n{_format_locations(manager, result)}'
    except Exception as exc:
        return _format_lsp_tool_error('reference lookup', exc, relative_path=relative_path)


@tool(LSP_DOCUMENT_SYMBOLS_NAME)
def lsp_get_document_symbols(relative_path: str) -> str:
    """List document symbols for a Python file using the active LSP session."""

    try:
        rel = _require_python_path(relative_path)
        manager = get_session_lsp_manager()
        symbols = manager.document_symbols(rel)
        lines = _format_symbols(symbols)
        if not lines:
            return f'No document symbols for `{rel}`.'
        return f'Document symbols for `{rel}`:\n' + '\n'.join(lines[:200])
    except Exception as exc:
        return _format_lsp_tool_error('document symbol lookup', exc, relative_path=relative_path)


@tool(LSP_CREATE_PYTHON_FILE_NAME)
def lsp_create_python_file(
    relative_path: str,
    new_content: str,
    encoding: str = '',
    newline: str = '',
) -> str:
    """Use for new `.py` files or whole-file Python rewrites; routes through staging and code review like `stage_create_file`.

    Provide the full relative path (nested directories are fine). Pass complete `new_content` for the file."""

    return _run_lsp_python_staging_tool(
        stage_create_file,
        {
            'relative_path': relative_path,
            'new_content': new_content,
            'encoding': encoding,
            'newline': newline,
        },
        relative_path=relative_path,
    )


@tool(LSP_UPDATE_PYTHON_FILE_NAME)
def lsp_update_python_file(
    relative_path: str,
    new_content: str,
    encoding: str = '',
    newline: str = '',
) -> str:
    """Use when the Python file already exists (or has a pending staged draft); supply the full updated file text.

    Overwrites through the staged LSP-aware mutation path (code review before workspace update)."""

    return _run_lsp_python_staging_tool(
        stage_workspace_file_overwrite,
        {
            'relative_path': relative_path,
            'new_content': new_content,
            'encoding': encoding,
            'newline': newline,
        },
        relative_path=relative_path,
    )


@tool(LSP_DELETE_PYTHON_FILE_NAME)
def lsp_delete_python_file(relative_path: str) -> str:
    """Use to remove a `.py` file from the workspace; clears LSP state for that document."""

    _require_python_path(relative_path)
    return delete_workspace_entry.invoke({'relative_path': relative_path})


PYTHON_LSP_READ_TOOLS: list[Any] = [
    lsp_get_diagnostics,
    lsp_hover,
    lsp_find_definition,
    lsp_find_references,
    lsp_get_document_symbols,
]

PYTHON_LSP_MUTATION_TOOLS: list[Any] = [
    lsp_create_python_file,
    lsp_update_python_file,
    lsp_delete_python_file,
]

# The code-review specialist only needs staged diagnostics visibility.
PYTHON_LSP_REVIEW_TOOLS: list[Any] = [
    lsp_get_diagnostics,
]
