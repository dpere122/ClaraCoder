"""LangChain tools for JSON search-and-zoom reading."""

from __future__ import annotations

from langchain_core.tools import tool

from nemo_backend.state import runtime_config
from nemo_backend.json.format import format_json_overview, format_search_results, format_section_detail
from nemo_backend.json.namespaces import SEARCH_SCOPES
from nemo_backend.json.parser import (
    build_json_graph,
    parse_section_ref,
    render_section_json,
    resolve_json_path,
    search_sections,
)

JSON_OVERVIEW_NAME = 'json_overview'
SEARCH_JSON_NAME = 'search_json'
READ_JSON_SECTION_NAME = 'read_json_section'

_MAX_OUTPUT_CHARS = 80_000
_MAX_SEARCH_MATCHES = 200


def _effective_max_search_matches(max_matches: int) -> int:
    configured = runtime_config.tools.max_search_results
    cap = max(1, min(int(configured), _MAX_SEARCH_MATCHES))
    return max(1, min(int(max_matches), cap))


def _truncate_output(text: str) -> str:
    from nemo_backend.workspace_tools import truncate_text_head_tail

    return truncate_text_head_tail(text, _MAX_OUTPUT_CHARS)


def _workspace_root():
    from nemo_backend.workspace_tools import get_active_workspace_root

    return get_active_workspace_root()


def _load_graph(relative_path: str):
    root = _workspace_root()
    target, err = resolve_json_path(root, relative_path)
    if err or target is None:
        return None, None, err
    rel_display = target.relative_to(root.resolve()).as_posix()
    graph = build_json_graph(root.resolve(), target, rel_display)
    if graph.parse_error:
        return None, rel_display, f'could not parse JSON `{rel_display}`: {graph.parse_error}'
    return graph, rel_display, None


@tool(JSON_OVERVIEW_NAME)
def json_overview(relative_path: str) -> str:
    """Index a JSON/JSONC file by paths (root type, key tree, array indices).

    When: starting work on `.json` or `.jsonc`; need structure before raw reads.
    Not: fuzzy file discovery (use `search_workspace`); line-level grep (use `search_workspace`).
    Shape: `relative_path` workspace-relative JSON path. Returns `section_ref` like `path:config.host`.
    Next: `search_json` or `read_json_section`."""

    graph, _rel_display, err = _load_graph(relative_path)
    if err:
        return f'Tool note: {err}'
    assert graph is not None
    return _truncate_output(format_json_overview(graph))


@tool(SEARCH_JSON_NAME)
def search_json(
    relative_path: str,
    query: str,
    scope: str = 'all',
    max_matches: int = 20,
) -> str:
    """Search indexed JSON by key path, key name, or scalar value (case-insensitive).

    When: locating fields after `json_overview`.
    Not: repo-wide file discovery.
    Shape: `scope` one of all|keys|values. Returns `section_ref` for zoom.
    Next: `read_json_section(relative_path, section_ref)`."""

    graph, _rel_display, err = _load_graph(relative_path)
    if err:
        return f'Tool note: {err}'
    assert graph is not None

    q = query.strip()
    if not q:
        return 'Tool note: `query` must be non-empty.'

    scope_norm = (scope or 'all').strip().lower()
    if scope_norm not in SEARCH_SCOPES:
        scope_norm = 'all'

    limit = _effective_max_search_matches(max_matches)
    matches = search_sections(graph, q, scope=scope_norm, max_matches=limit)
    out = format_search_results(graph, q, matches, scope=scope_norm)
    return _truncate_output(out)


@tool(READ_JSON_SECTION_NAME)
def read_json_section(relative_path: str, section_ref: str) -> str:
    """Zoom into one JSON subtree by `section_ref` (pretty-printed JSON).

    When: you have `section_ref` from `json_overview` or `search_json`.
    Not: first pass on unknown JSON (use `json_overview` first).
    Shape: `section_ref` like `path:$`, `path:users[0].profile`, `path:items[2]`."""

    graph, _rel_display, err = _load_graph(relative_path)
    if err:
        return f'Tool note: {err}'
    assert graph is not None

    ref_key = parse_section_ref(section_ref)
    if ref_key is None:
        return (
            'Tool note: invalid `section_ref`. Expected `path:$` (root), `path:config.host`, '
            'or `path:items[0].sku`.'
        )

    section = graph.sections.get(ref_key)
    if section is None:
        known = graph.section_refs()[:20]
        hint = ', '.join(known) if known else '(none indexed)'
        return (
            f'Tool note: section_ref `{section_ref}` not found. '
            f'Run `json_overview` or `search_json`. Examples: {hint}'
        )

    json_body = render_section_json(section)
    out = format_section_detail(graph, section, json_body)
    return _truncate_output(out)


JSON_TOOLS = [json_overview, search_json, read_json_section]
