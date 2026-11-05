"""LSP features beyond the core editor set, behind one route (``POST /lsp/editor/feature``).

Each feature takes the document, 1-based Monaco positions and JSON params, and returns a payload
in Monaco's shape. A feature the server doesn't offer returns its empty payload.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from clara_coder_backend.lsp.editor_monaco import (
    _collect_workspace_edit_changes,
    _lsp_range_to_monaco_irange,
    _serialize_text_edit,
    serialize_inlay_hints_payload,
    serialize_locations_payload,
    serialize_semantic_tokens_payload,
    workspace_rel_from_uri,
)

_HIERARCHY_RESULT_LIMIT = 200
_WORKSPACE_SYMBOL_LIMIT = 200


def _lsp_position(line: Any, character: Any) -> dict[str, int]:
    return {'line': max(0, int(line) - 1), 'character': max(0, int(character) - 1)}


def _lsp_range(params: dict[str, Any]) -> dict[str, dict[str, int]]:
    return {
        'start': _lsp_position(params['start_line'], params['start_character']),
        'end': _lsp_position(params['end_line'], params['end_character']),
    }


def _position_params(params: dict[str, Any]) -> dict[str, Any]:
    return {'position': _lsp_position(params['line'], params['character'])}


def _navigation(method: str, provider: str) -> Callable[[Any, str, dict[str, Any]], dict[str, Any]]:
    def run(manager: Any, rel: str, params: dict[str, Any]) -> dict[str, Any]:
        raw = manager.document_request(rel, method, provider=provider, params=_position_params(params))
        return {'locations': serialize_locations_payload(manager, raw)}

    return run


def _prepare_rename(manager: Any, rel: str, params: dict[str, Any]) -> dict[str, Any]:
    raw = manager.document_request(
        rel, 'textDocument/prepareRename', provider='renameProvider', params=_position_params(params)
    )
    if not isinstance(raw, dict):
        return {'range': None, 'placeholder': None}
    # ``Range`` | ``{range, placeholder}`` | ``{defaultBehavior}``.
    rng = raw.get('range') if 'range' in raw else (raw if 'start' in raw else None)
    return {
        'range': _lsp_range_to_monaco_irange(rng) if rng else None,
        'placeholder': raw.get('placeholder'),
    }


def _folding_ranges(manager: Any, rel: str, params: dict[str, Any]) -> dict[str, Any]:
    raw = manager.document_request(rel, 'textDocument/foldingRange', provider='foldingRangeProvider')
    ranges: list[dict[str, Any]] = []
    for item in raw if isinstance(raw, list) else []:
        if isinstance(item, dict) and 'startLine' in item and 'endLine' in item:
            ranges.append({'start': int(item['startLine']) + 1, 'end': int(item['endLine']) + 1, 'kind': item.get('kind')})
    return {'ranges': ranges}


def _selection_ranges(manager: Any, rel: str, params: dict[str, Any]) -> dict[str, Any]:
    positions = [
        _lsp_position(p['lineNumber'], p['column'])
        for p in params.get('positions') or []
        if isinstance(p, dict)
    ]
    raw = manager.document_request(
        rel,
        'textDocument/selectionRange',
        provider='selectionRangeProvider',
        params={'positions': positions},
    )
    chains: list[list[dict[str, int]]] = []
    for item in raw if isinstance(raw, list) else []:
        chain: list[dict[str, int]] = []
        node = item
        while isinstance(node, dict):
            ir = _lsp_range_to_monaco_irange(node.get('range'))
            if ir is not None:
                chain.append(ir)
            node = node.get('parent')
        chains.append(chain)
    return {'selections': chains}


def _document_colors(manager: Any, rel: str, params: dict[str, Any]) -> dict[str, Any]:
    raw = manager.document_request(rel, 'textDocument/documentColor', provider='colorProvider')
    colors: list[dict[str, Any]] = []
    for item in raw if isinstance(raw, list) else []:
        ir = _lsp_range_to_monaco_irange(item.get('range')) if isinstance(item, dict) else None
        if ir is not None and isinstance(item.get('color'), dict):
            colors.append({'range': ir, 'color': item['color']})
    return {'colors': colors}


def _color_presentations(manager: Any, rel: str, params: dict[str, Any]) -> dict[str, Any]:
    raw = manager.document_request(
        rel,
        'textDocument/colorPresentation',
        provider='colorProvider',
        params={'color': params.get('color') or {}, 'range': _lsp_range(params)},
    )
    out: list[dict[str, Any]] = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        row: dict[str, Any] = {'label': str(item.get('label') or '')}
        edit = _serialize_text_edit(item.get('textEdit'))
        if edit is not None:
            row['textEdit'] = edit
        out.append(row)
    return {'presentations': out}


def _document_links(manager: Any, rel: str, params: dict[str, Any]) -> dict[str, Any]:
    raw = manager.document_request(rel, 'textDocument/documentLink', provider='documentLinkProvider')
    links: list[dict[str, Any]] = []
    for item in raw if isinstance(raw, list) else []:
        ir = _lsp_range_to_monaco_irange(item.get('range')) if isinstance(item, dict) else None
        target = str(item.get('target') or '') if isinstance(item, dict) else ''
        if ir is None or not target:
            continue
        row: dict[str, Any] = {'range': ir}
        if item.get('tooltip'):
            row['tooltip'] = str(item['tooltip'])
        if target.startswith('file:'):
            target_rel = workspace_rel_from_uri(manager, target)
            if target_rel:
                row['relativePath'] = target_rel
        else:
            row['url'] = target
        if 'relativePath' in row or 'url' in row:
            links.append(row)
    return {'links': links}


def _inlay_hint_resolve(manager: Any, rel: str, params: dict[str, Any]) -> dict[str, Any]:
    hint = params.get('hint')
    if not isinstance(hint, dict):
        return {'hint': None}
    raw = manager.server_request('inlayHint/resolve', hint, provider='inlayHintProvider', timeout_s=8.0)
    rows = serialize_inlay_hints_payload([raw]) if isinstance(raw, dict) else []
    return {'hint': rows[0] if rows else None}


def _semantic_tokens_range(manager: Any, rel: str, params: dict[str, Any]) -> dict[str, Any]:
    raw = manager.document_request(
        rel,
        'textDocument/semanticTokens/range',
        provider='semanticTokensProvider',
        params={'range': _lsp_range(params)},
        timeout_s=20.0,
    )
    return {'payload': serialize_semantic_tokens_payload(manager, raw)}


def _item_location(manager: Any, item: dict[str, Any], rng: Any, *, name: str | None = None) -> dict[str, Any] | None:
    rows = serialize_locations_payload(manager, {'uri': item.get('uri'), 'range': rng})
    if not rows:
        return None
    row = rows[0]
    row['name'] = name or str(item.get('name') or '')
    row['detail'] = str(item.get('detail') or '')
    row['kind'] = item.get('kind')
    return row


def _call_hierarchy(manager: Any, rel: str, params: dict[str, Any]) -> dict[str, Any]:
    """One level of callers (``incoming``) or callees (``outgoing``) of the symbol at the position."""

    incoming = params.get('direction') != 'outgoing'
    items = manager.document_request(
        rel,
        'textDocument/prepareCallHierarchy',
        provider='callHierarchyProvider',
        params=_position_params(params),
    )
    method = 'callHierarchy/incomingCalls' if incoming else 'callHierarchy/outgoingCalls'
    out: list[dict[str, Any]] = []
    for item in items if isinstance(items, list) else []:
        calls = manager.server_request(method, {'item': item}, provider='callHierarchyProvider')
        for call in calls if isinstance(calls, list) else []:
            if not isinstance(call, dict):
                continue
            # A caller's ``fromRanges`` are the call sites inside it; a callee is shown at its declaration.
            target = call.get('from' if incoming else 'to')
            if not isinstance(target, dict):
                continue
            from_ranges = call.get('fromRanges') or []
            rng = from_ranges[0] if incoming and from_ranges else target.get('selectionRange') or target.get('range')
            row = _item_location(manager, target, rng)
            if row is not None:
                out.append(row)
    return {'locations': out[:_HIERARCHY_RESULT_LIMIT]}


def _type_hierarchy(manager: Any, rel: str, params: dict[str, Any]) -> dict[str, Any]:
    """Direct ``supertypes`` or ``subtypes`` of the class at the position."""

    direction = 'subtypes' if params.get('direction') == 'subtypes' else 'supertypes'
    items = manager.document_request(
        rel,
        'textDocument/prepareTypeHierarchy',
        provider='typeHierarchyProvider',
        params=_position_params(params),
    )
    out: list[dict[str, Any]] = []
    for item in items if isinstance(items, list) else []:
        related = manager.server_request(f'typeHierarchy/{direction}', {'item': item}, provider='typeHierarchyProvider')
        for target in related if isinstance(related, list) else []:
            if isinstance(target, dict):
                row = _item_location(manager, target, target.get('selectionRange') or target.get('range'))
                if row is not None:
                    out.append(row)
    return {'locations': out[:_HIERARCHY_RESULT_LIMIT]}


EDITOR_FEATURES: dict[str, Callable[[Any, str, dict[str, Any]], dict[str, Any]]] = {
    'implementation': _navigation('textDocument/implementation', 'implementationProvider'),
    'typeDefinition': _navigation('textDocument/typeDefinition', 'typeDefinitionProvider'),
    'declaration': _navigation('textDocument/declaration', 'declarationProvider'),
    'prepareRename': _prepare_rename,
    'foldingRanges': _folding_ranges,
    'selectionRanges': _selection_ranges,
    'documentColors': _document_colors,
    'colorPresentations': _color_presentations,
    'documentLinks': _document_links,
    'inlayHintResolve': _inlay_hint_resolve,
    'semanticTokensRange': _semantic_tokens_range,
    'callHierarchy': _call_hierarchy,
    'typeHierarchy': _type_hierarchy,
}


def run_editor_feature(manager: Any, rel: str, feature: str, params: dict[str, Any]) -> dict[str, Any]:
    handler = EDITOR_FEATURES.get(feature)
    if handler is None:
        raise ValueError(f'Unknown LSP editor feature: {feature!r}')
    return handler(manager, rel, params)


def workspace_symbols(manager: Any, query: str) -> list[dict[str, Any]]:
    """``workspace/symbol`` as named locations."""

    raw = manager.server_request('workspace/symbol', {'query': query}, provider='workspaceSymbolProvider', timeout_s=20.0)
    out: list[dict[str, Any]] = []
    for sym in raw if isinstance(raw, list) else []:
        if not isinstance(sym, dict) or not isinstance(sym.get('location'), dict):
            continue
        location = sym['location']
        # ``WorkspaceSymbol.location`` may omit the range; such a symbol opens at the top of the file.
        rng = location.get('range') or {'start': {'line': 0, 'character': 0}, 'end': {'line': 0, 'character': 0}}
        rows = serialize_locations_payload(manager, {'uri': location.get('uri'), 'range': rng})
        if rows:
            rows[0].update(
                name=str(sym.get('name') or ''),
                kind=sym.get('kind'),
                containerName=str(sym.get('containerName') or ''),
            )
            out.append(rows[0])
        if len(out) >= _WORKSPACE_SYMBOL_LIMIT:
            break
    return out


def file_rename_edits(manager: Any, renames: list[tuple[str, str]]) -> dict[str, list[dict[str, Any]]]:
    """Edits fixing references to moved files, as ``{relative path: text edits}``."""

    raw = manager.will_rename_files(renames)
    return _collect_workspace_edit_changes(manager, raw) if isinstance(raw, dict) else {}
