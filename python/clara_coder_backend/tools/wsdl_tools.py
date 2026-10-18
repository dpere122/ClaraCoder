"""Format backend (behind :mod:`clara_coder_backend.tools.structured_tools`) for WSDL 1.1 search-and-zoom reading."""

from __future__ import annotations

from clara_coder_backend.session.state import runtime_config
from clara_coder_backend.wsdl.format import format_search_results, format_section_detail, format_wsdl_overview
from clara_coder_backend.wsdl.parser import (
    build_wsdl_graph,
    parse_section_ref,
    render_section_xml,
    resolve_wsdl_path,
    search_sections,
)
from clara_coder_backend.wsdl.namespaces import SEARCH_SCOPES


_MAX_OUTPUT_CHARS = 80_000
_MAX_SEARCH_MATCHES = 200
_DEFAULT_IMPORT_DEPTH = 1


def _effective_max_search_matches(max_matches: int) -> int:
    configured = runtime_config.tools.max_search_results
    cap = max(1, min(int(configured), _MAX_SEARCH_MATCHES))
    return max(1, min(int(max_matches), cap))


def _truncate_output(text: str) -> str:
    from clara_coder_backend.tools.workspace import truncate_text_head_tail

    return truncate_text_head_tail(text, _MAX_OUTPUT_CHARS)


def _workspace_root():
    from clara_coder_backend.tools.workspace import get_active_workspace_root

    return get_active_workspace_root()


def _clamp_import_depth(import_depth: int) -> int:
    return max(0, min(int(import_depth), 3))


def wsdl_overview(
    relative_path: str,
    import_depth: int = _DEFAULT_IMPORT_DEPTH,
) -> str:

    root = _workspace_root()
    target, err = resolve_wsdl_path(root, relative_path)
    if err or target is None:
        return f'Tool note: {err}'

    rel_display = target.relative_to(root.resolve()).as_posix()
    graph = build_wsdl_graph(
        root.resolve(),
        target,
        rel_display,
        import_depth=_clamp_import_depth(import_depth),
    )
    entry_doc = graph.documents[0] if graph.documents else None
    if entry_doc and entry_doc.parse_error:
        return f'Tool note: could not parse WSDL `{rel_display}`: {entry_doc.parse_error}'

    out = format_wsdl_overview(graph)
    return _truncate_output(out)


def search_wsdl(
    relative_path: str,
    query: str,
    scope: str = 'all',
    max_matches: int = 20,
    import_depth: int = _DEFAULT_IMPORT_DEPTH,
) -> str:

    root = _workspace_root()
    target, err = resolve_wsdl_path(root, relative_path)
    if err or target is None:
        return f'Tool note: {err}'

    q = query.strip()
    if not q:
        return 'Tool note: `query` must be non-empty.'

    scope_norm = (scope or 'all').strip().lower()
    if scope_norm not in SEARCH_SCOPES:
        scope_norm = 'all'

    rel_display = target.relative_to(root.resolve()).as_posix()
    graph = build_wsdl_graph(
        root.resolve(),
        target,
        rel_display,
        import_depth=_clamp_import_depth(import_depth),
    )
    entry_doc = graph.documents[0] if graph.documents else None
    if entry_doc and entry_doc.parse_error:
        return f'Tool note: could not parse WSDL `{rel_display}`: {entry_doc.parse_error}'

    limit = _effective_max_search_matches(max_matches)
    matches = search_sections(graph, q, scope=scope_norm, max_matches=limit)
    out = format_search_results(graph, q, matches, scope=scope_norm)
    return _truncate_output(out)


def read_wsdl_section(
    relative_path: str,
    section_ref: str,
    import_depth: int = _DEFAULT_IMPORT_DEPTH,
) -> str:

    root = _workspace_root()
    target, err = resolve_wsdl_path(root, relative_path)
    if err or target is None:
        return f'Tool note: {err}'

    parsed = parse_section_ref(section_ref)
    if parsed is None:
        return (
            'Tool note: invalid `section_ref`. Expected kind:name, e.g. '
            '`operation:CustomerPortType/GetCustomer`, `message:GetCustomerRequest`, `type:CustomerType`.'
        )

    rel_display = target.relative_to(root.resolve()).as_posix()
    graph = build_wsdl_graph(
        root.resolve(),
        target,
        rel_display,
        import_depth=_clamp_import_depth(import_depth),
    )
    entry_doc = graph.documents[0] if graph.documents else None
    if entry_doc and entry_doc.parse_error:
        return f'Tool note: could not parse WSDL `{rel_display}`: {entry_doc.parse_error}'

    ref_key = f'{parsed[0]}:{parsed[1]}'
    section = graph.sections.get(ref_key)
    if section is None:
        known = graph.section_refs()[:20]
        hint = ', '.join(known) if known else '(none indexed)'
        return (
            f'Tool note: section_ref `{section_ref}` not found in `{rel_display}`. '
            f'Run `structured_overview` or `search_structured`. Examples indexed: {hint}'
        )

    xml_body = render_section_xml(section, expand_depth=0)
    out = format_section_detail(graph, section, xml_body)
    return _truncate_output(out)
