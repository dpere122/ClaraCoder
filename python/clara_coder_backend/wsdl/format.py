"""Format WSDL index/search/section output for model consumption."""

from __future__ import annotations

from clara_coder_backend.wsdl.parser import ImportRecord, SectionRecord, WsdlDocument, WsdlGraph

_OVERVIEW_LIST_CAP = 50


def _truncate_list(items: list[str], cap: int = _OVERVIEW_LIST_CAP) -> tuple[list[str], int]:
    if len(items) <= cap:
        return items, 0
    return items[:cap], len(items) - cap


def _format_imports(imports: list[ImportRecord]) -> list[str]:
    lines: list[str] = []
    for imp in imports:
        status = imp.resolved_path or imp.error or 'unresolved'
        ns_part = f' ns={imp.namespace!r}' if imp.namespace else ''
        lines.append(f'  - {imp.kind} location={imp.location!r}{ns_part} → {status}')
    return lines


def format_wsdl_overview(graph: WsdlGraph) -> str:
    """Render compact overview of a WSDL graph."""
    lines: list[str] = [
        f'WSDL: {graph.entry_rel_path}',
        f'Import depth: {graph.import_depth}',
        f'Files parsed: {len(graph.documents)}',
    ]

    parse_errors = [doc for doc in graph.documents if doc.parse_error]
    if parse_errors:
        for doc in parse_errors:
            lines.append(f'Parse warning [{doc.rel_path}]: {doc.parse_error}')

    for doc in graph.documents:
        if doc.parse_error:
            continue
        lines.append('')
        lines.append(f'--- {doc.rel_path} ---')
        if doc.target_namespace:
            lines.append(f'targetNamespace: {doc.target_namespace}')
        imp_lines = _format_imports(doc.imports)
        if imp_lines:
            lines.append('imports:')
            lines.extend(imp_lines)

    if graph.unresolved_imports:
        lines.append('')
        lines.append('Unresolved imports (not searched beyond depth cap):')
        lines.extend(_format_imports(graph.unresolved_imports))

    by_kind: dict[str, list[SectionRecord]] = {}
    for section in graph.sections.values():
        by_kind.setdefault(section.kind, []).append(section)

    kind_order = (
        'service',
        'port',
        'portType',
        'operation',
        'message',
        'binding',
        'binding_op',
        'element',
        'type',
    )
    lines.append('')
    lines.append('Index (use section_ref with read_structured_section):')
    for kind in kind_order:
        entries = sorted(by_kind.get(kind, []), key=lambda s: s.ref)
        if not entries:
            continue
        refs = [f'{s.ref} — {s.summary}' for s in entries]
        shown, remaining = _truncate_list(refs)
        lines.append(f'{kind}s ({len(entries)}):')
        for item in shown:
            lines.append(f'  - {item}')
        if remaining:
            lines.append(f'  ... [{remaining} more; use search_structured to narrow]')

    lines.append('')
    lines.append(
        'Next: search_structured(relative_path, query) for names, or '
        'read_structured_section(relative_path, section_ref) to zoom.'
    )
    return '\n'.join(lines)


def format_search_results(
    graph: WsdlGraph,
    query: str,
    matches: list[SectionRecord],
    *,
    scope: str,
) -> str:
    if not matches:
        return f'No WSDL matches for query={query!r} (scope={scope}).'

    lines = [
        f'WSDL search: {graph.entry_rel_path}',
        f'Query: {query!r}  Scope: {scope}',
        f'Matches: {len(matches)}',
        '',
    ]
    for section in matches:
        lines.append(f'- section_ref={section.ref!r}')
        lines.append(f'  file={section.file_path}  kind={section.kind}  summary={section.summary}')
    lines.append('')
    lines.append('Zoom with read_structured_section(relative_path, section_ref).')
    return '\n'.join(lines)


def format_section_detail(
    graph: WsdlGraph,
    section: SectionRecord,
    xml_body: str,
) -> str:
    header = (
        f'WSDL section: {section.ref}\n'
        f'File: {section.file_path}\n'
        f'Kind: {section.kind}\n'
        f'Summary: {section.summary}\n'
        f'Entry WSDL: {graph.entry_rel_path}\n\n'
    )
    return header + xml_body
