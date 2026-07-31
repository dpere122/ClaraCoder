"""Format XML overview/search/section output."""

from __future__ import annotations

from clara_coder_backend.xml.parser import SectionRecord, XmlGraph

_OVERVIEW_PATH_CAP = 80
_TREE_DEPTH = 3


def _truncate_list(items: list[str], cap: int) -> tuple[list[str], int]:
    if len(items) <= cap:
        return items, 0
    return items[:cap], len(items) - cap


def _tree_lines(graph: XmlGraph, max_depth: int = _TREE_DEPTH) -> list[str]:
    lines: list[str] = []
    for section in sorted(graph.sections.values(), key=lambda s: s.path):
        if section.depth > max_depth:
            continue
        indent = '  ' * section.depth
        lines.append(f'{indent}{section.path}  ({section.summary})')
    shown, remaining = _truncate_list(lines, _OVERVIEW_PATH_CAP)
    if remaining:
        shown.append(f'  ... [{remaining} more paths; use search_xml or read_xml_section]')
    return shown


def format_xml_overview(graph: XmlGraph) -> str:
    lines = [
        f'XML: {graph.entry_rel_path}',
        f'Root element: {graph.root_tag or "(unknown)"}',
        f'Indexed nodes: {graph.node_count}',
    ]
    if graph.truncated:
        lines.append(f'Note: indexing stopped at node cap; use search_xml to locate deeper nodes.')
    if graph.namespaces:
        ns_items = [f'{k}={v!r}' for k, v in sorted(graph.namespaces.items()) if k.startswith('{') or k.startswith('xmlns')]
        if ns_items:
            lines.append('Root namespaces/attrs: ' + ', '.join(ns_items[:20]))

    tree = _tree_lines(graph)
    if tree:
        lines.append('')
        lines.append('Path tree (use section_ref path:/... with read_xml_section):')
        lines.extend(tree)

    lines.append('')
    lines.append('Next: search_xml(relative_path, query) or read_xml_section(relative_path, section_ref).')
    return '\n'.join(lines)


def format_search_results(
    graph: XmlGraph,
    query: str,
    matches: list[SectionRecord],
    *,
    scope: str,
) -> str:
    if not matches:
        return f'No XML matches for query={query!r} (scope={scope}).'

    lines = [
        f'XML search: {graph.entry_rel_path}',
        f'Query: {query!r}  Scope: {scope}',
        f'Matches: {len(matches)}',
        '',
    ]
    for section in matches:
        lines.append(f'- section_ref={section.ref!r}')
        lines.append(f'  path={section.path}  summary={section.summary}')
    lines.append('')
    lines.append('Zoom with read_xml_section(relative_path, section_ref).')
    return '\n'.join(lines)


def format_section_detail(graph: XmlGraph, section: SectionRecord, xml_body: str) -> str:
    header = (
        f'XML section: {section.ref}\n'
        f'File: {graph.entry_rel_path}\n'
        f'Path: {section.path}\n'
        f'Summary: {section.summary}\n\n'
    )
    return header + xml_body
