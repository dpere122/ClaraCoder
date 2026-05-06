"""Normalize LSP JSON responses for the Monaco workspace editor (ranges, URIs, edits)."""

from __future__ import annotations

from typing import Any

from nemo_backend.lsp.manager import _uri_to_path


def workspace_rel_from_uri(manager: Any, uri: str) -> str:
    target = _uri_to_path(str(uri))
    try:
        return target.resolve().relative_to(manager.workspace_root.resolve()).as_posix()
    except Exception:
        return target.as_posix()


def _lsp_range_to_monaco_irange(rng: Any) -> dict[str, int] | None:
    if not isinstance(rng, dict):
        return None
    start = rng.get('start') if isinstance(rng.get('start'), dict) else {}
    end = rng.get('end') if isinstance(rng.get('end'), dict) else {}
    sl = int(start.get('line', 0))
    sc = int(start.get('character', 0))
    el = int(end.get('line', 0))
    ec = int(end.get('character', 0))
    return {
        'startLineNumber': sl + 1,
        'startColumn': sc + 1,
        'endLineNumber': el + 1,
        'endColumn': ec + 1,
    }


def serialize_locations_payload(manager: Any, raw: Any) -> list[dict[str, Any]]:
    """Flatten Location | Location[] | LocationLink[] to workspace-relative Monaco ranges."""

    if raw is None:
        return []
    items = raw if isinstance(raw, list) else [raw]
    out: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        uri = str(item.get('uri') or item.get('targetUri') or '')
        rng = item.get('range') or item.get('targetSelectionRange') or item.get('targetRange') or {}
        if not uri:
            continue
        rel = workspace_rel_from_uri(manager, uri)
        ir = _lsp_range_to_monaco_irange(rng)
        if ir is None:
            continue
        out.append({'relativePath': rel, 'range': ir})
    return out


def _format_documentation(doc: Any) -> str | dict[str, Any] | None:
    if doc is None:
        return None
    if isinstance(doc, str):
        return doc
    if isinstance(doc, dict):
        kind = str(doc.get('kind') or '').lower()
        val = doc.get('value')
        if kind == 'markdown' and val is not None:
            return {'value': str(val), 'isTrusted': True}
        if val is not None:
            return str(val)
    return str(doc)


def _serialize_text_edit(edit: Any) -> dict[str, Any] | None:
    if not isinstance(edit, dict):
        return None
    ir = _lsp_range_to_monaco_irange(edit.get('range'))
    if ir is None:
        return None
    nt = edit.get('newText')
    return {'range': ir, 'newText': '' if nt is None else str(nt)}


def _serialize_any_text_edit(edit: Any) -> dict[str, Any] | None:
    """Plain ``TextEdit`` or ``InsertReplaceEdit`` (uses ``insert`` range)."""

    if not isinstance(edit, dict):
        return None
    if edit.get('range') is not None:
        return _serialize_text_edit(edit)
    ins = edit.get('insert')
    if isinstance(ins, dict):
        ir = _lsp_range_to_monaco_irange(ins)
        nt = edit.get('newText')
        if ir is not None:
            return {'range': ir, 'newText': '' if nt is None else str(nt)}
    return None


def serialize_completion_result(manager: Any, raw: Any) -> dict[str, Any]:
    """Shape ``textDocument/completion`` for the renderer (Monaco ``CompletionList``-like)."""

    if raw is None:
        return {'isIncomplete': False, 'items': []}
    if isinstance(raw, list):
        items_src = raw
        incomplete = False
    elif isinstance(raw, dict):
        items_src = raw.get('items') or []
        incomplete = bool(raw.get('isIncomplete'))
    else:
        return {'isIncomplete': False, 'items': []}

    items: list[dict[str, Any]] = []
    for it in items_src[:500]:
        if not isinstance(it, dict):
            continue
        label = it.get('label')
        if isinstance(label, dict):
            label = label.get('label') or label.get('detail')
        entry: dict[str, Any] = {
            'label': '' if label is None else str(label),
            'kind': it.get('kind'),
            'detail': it.get('detail'),
            'documentation': _format_documentation(it.get('documentation')),
            'filterText': it.get('filterText'),
            'sortText': it.get('sortText'),
            'insertText': it.get('insertText'),
            'insertTextFormat': it.get('insertTextFormat'),
        }
        te = _serialize_any_text_edit(it.get('textEdit'))
        if te is not None:
            entry['textEdit'] = te
        ate = it.get('additionalTextEdits')
        if isinstance(ate, list):
            extra = [x for x in (_serialize_any_text_edit(x) for x in ate) if x is not None]
            if extra:
                entry['additionalTextEdits'] = extra
        items.append(entry)

    return {'isIncomplete': incomplete, 'items': items}


def _collect_workspace_edit_changes(manager: Any, raw: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    changes: dict[str, list[dict[str, Any]]] = {}

    legacy = raw.get('changes')
    if isinstance(legacy, dict):
        for uri, edits in legacy.items():
            rel = workspace_rel_from_uri(manager, str(uri))
            if not isinstance(edits, list):
                continue
            bucket = changes.setdefault(rel, [])
            for e in edits:
                se = _serialize_text_edit(e)
                if se is not None:
                    bucket.append(se)

    doc_edits = raw.get('documentChanges')
    if isinstance(doc_edits, list):
        for block in doc_edits:
            if not isinstance(block, dict):
                continue
            td = block.get('textDocument')
            uri = ''
            if isinstance(td, dict):
                uri = str(td.get('uri') or '')
            if not uri:
                uri = str(block.get('uri') or '')
            if not uri:
                continue
            rel = workspace_rel_from_uri(manager, uri)
            bucket = changes.setdefault(rel, [])
            for e in block.get('edits') or []:
                se = _serialize_text_edit(e)
                if se is not None:
                    bucket.append(se)

    return changes


def serialize_rename_workspace_edit(manager: Any, raw: Any) -> dict[str, Any] | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        return None
    changes = _collect_workspace_edit_changes(manager, raw)
    return {'changes': changes}


def _serialize_document_symbol(sym: Any) -> dict[str, Any] | None:
    if not isinstance(sym, dict):
        return None
    name = str(sym.get('name') or '')
    kind = sym.get('kind')
    detail = sym.get('detail')
    rng = _lsp_range_to_monaco_irange(sym.get('range'))
    sel = _lsp_range_to_monaco_irange(sym.get('selectionRange')) or rng
    if rng is None:
        return None
    row: dict[str, Any] = {
        'name': name,
        'kind': kind,
        'range': rng,
        'selectionRange': sel or rng,
    }
    if detail is not None:
        row['detail'] = str(detail)
    children_in = sym.get('children')
    if isinstance(children_in, list) and children_in:
        kids = [c for c in (_serialize_document_symbol(c) for c in children_in) if c is not None]
        if kids:
            row['children'] = kids
    return row


def serialize_document_symbols_payload(manager: Any, raw: Any) -> dict[str, Any]:
    """``textDocument/documentSymbol`` → hierarchical symbols or flat ``SymbolInformation``."""

    if raw is None:
        return {'hierarchical': [], 'flat': []}
    if not isinstance(raw, list):
        return {'hierarchical': [], 'flat': []}

    hierarchical: list[dict[str, Any]] = []
    flat: list[dict[str, Any]] = []

    for item in raw[:2000]:
        if not isinstance(item, dict):
            continue
        if 'location' in item and 'range' not in item:
            loc = item.get('location')
            if isinstance(loc, dict):
                uri = str(loc.get('uri') or '')
                rng = loc.get('range')
                ir = _lsp_range_to_monaco_irange(rng)
                rel = workspace_rel_from_uri(manager, uri) if uri else ''
                if ir is not None:
                    flat.append(
                        {
                            'name': str(item.get('name') or ''),
                            'kind': item.get('kind'),
                            'containerName': item.get('containerName'),
                            'relativePath': rel,
                            'range': ir,
                        }
                    )
            continue
        ser = _serialize_document_symbol(item)
        if ser is not None:
            hierarchical.append(ser)

    return {'hierarchical': hierarchical, 'flat': flat}


def serialize_semantic_tokens_payload(manager: Any, raw: Any) -> dict[str, Any]:
    """Shape ``textDocument/semanticTokens/full`` + legend for the Monaco editor."""

    leg = getattr(manager, 'semantic_tokens_legend', None)
    if isinstance(leg, dict):
        legend = {
            'tokenTypes': [str(x) for x in (leg.get('tokenTypes') or [])],
            'tokenModifiers': [str(x) for x in (leg.get('tokenModifiers') or [])],
        }
    else:
        legend = {'tokenTypes': [], 'tokenModifiers': []}

    if raw is None:
        return {'legend': legend, 'data': [], 'resultId': None}
    if not isinstance(raw, dict):
        return {'legend': legend, 'data': [], 'resultId': None}
    data = raw.get('data')
    if not isinstance(data, list):
        data = []
    out_data = [int(x) for x in data]
    rid = raw.get('resultId')
    return {
        'legend': legend,
        'data': out_data,
        'resultId': None if rid is None else str(rid),
    }
