"""Format JSON overview/search/section output."""

from __future__ import annotations

from clara_coder_backend.json.parser import JsonGraph, SectionRecord

_OVERVIEW_PATH_CAP = 80
_TREE_DEPTH = 4


def _truncate_list(items: list[str], cap: int) -> tuple[list[str], int]:
    if len(items) <= cap:
        return items, 0
    return items[:cap], len(items) - cap


def _depth_of_path(path: str) -> int:
    if not path or path == '$':
        return 0
    depth = 0
    for ch in path:
        if ch in '.[':
            depth += 1
    return depth


def _tree_lines(graph: JsonGraph, max_depth: int = _TREE_DEPTH) -> list[str]:
    lines: list[str] = []
    for section in sorted(graph.sections.values(), key=lambda s: s.path):
        depth = _depth_of_path(section.path)
        if depth > max_depth:
            continue
        indent = '  ' * depth
        display_path = section.path or '$'
        lines.append(f'{indent}{display_path}  ({section.summary})')
    shown, remaining = _truncate_list(lines, _OVERVIEW_PATH_CAP)
    if remaining:
        shown.append(f'  ... [{remaining} more paths; use search_json or read_json_section]')
    return shown


def format_json_overview(graph: JsonGraph) -> str:
    lines = [
        f'JSON: {graph.entry_rel_path}',
        f'Root type: {graph.root_kind or "(unknown)"}',
        f'Indexed paths: {graph.path_count}',
    ]
    if graph.truncated:
        lines.append('Note: indexing stopped at path cap; use search_json to locate deeper nodes.')

    tree = _tree_lines(graph)
    if tree:
        lines.append('')
        lines.append('Path tree (use section_ref path:... with read_json_section):')
        lines.extend(tree)

    lines.append('')
    lines.append('Examples: path:$ (root), path:config.host, path:items[0].id')
    lines.append('Next: search_json(relative_path, query) or read_json_section(relative_path, section_ref).')
    return '\n'.join(lines)


def format_search_results(
    graph: JsonGraph,
    query: str,
    matches: list[SectionRecord],
    *,
    scope: str,
) -> str:
    if not matches:
        return f'No JSON matches for query={query!r} (scope={scope}).'

    lines = [
        f'JSON search: {graph.entry_rel_path}',
        f'Query: {query!r}  Scope: {scope}',
        f'Matches: {len(matches)}',
        '',
    ]
    for section in matches:
        lines.append(f'- section_ref={section.ref!r}')
        lines.append(f'  path={section.path or "$"}  summary={section.summary}')
    lines.append('')
    lines.append('Zoom with read_json_section(relative_path, section_ref).')
    return '\n'.join(lines)


def format_section_detail(graph: JsonGraph, section: SectionRecord, json_body: str) -> str:
    header = (
        f'JSON section: {section.ref}\n'
        f'File: {graph.entry_rel_path}\n'
        f'Path: {section.path or "$"}\n'
        f'Summary: {section.summary}\n\n'
    )
    return header + json_body
