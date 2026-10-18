"""Format backend (behind :mod:`clara_coder_backend.tools.structured_tools`) for JSON search-and-zoom reading."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from clara_coder_backend.session.state import runtime_config
from clara_coder_backend.json.format import format_json_overview, format_search_results, format_section_detail
from clara_coder_backend.json.namespaces import SEARCH_SCOPES
from clara_coder_backend.json.parser import (
    build_json_graph,
    parse_section_ref,
    render_section_json,
    resolve_json_path,
    search_sections,
)


_MAX_OUTPUT_CHARS = 80_000
_MAX_SEARCH_MATCHES = 200


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


@lru_cache(maxsize=16)
def _cached_graph(root: str, target: str, rel_display: str, _mtime_ns: int, _size: int):
    """Parse once per (file, mtime, size): overview → search → read on one file reuses the graph."""
    return build_json_graph(Path(root), Path(target), rel_display)


def _load_graph(relative_path: str):
    root = _workspace_root()
    target, err = resolve_json_path(root, relative_path)
    if err or target is None:
        return None, None, err
    rel_display = target.relative_to(root.resolve()).as_posix()
    st = target.stat()
    graph = _cached_graph(str(root.resolve()), str(target), rel_display, st.st_mtime_ns, st.st_size)
    if graph.parse_error:
        return None, rel_display, f'could not parse JSON `{rel_display}`: {graph.parse_error}'
    return graph, rel_display, None


def json_overview(relative_path: str) -> str:

    graph, _rel_display, err = _load_graph(relative_path)
    if err:
        return f'Tool note: {err}'
    assert graph is not None
    return _truncate_output(format_json_overview(graph))


def search_json(
    relative_path: str,
    query: str,
    scope: str = 'all',
    max_matches: int = 20,
) -> str:

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


def read_json_section(
    relative_path: str,
    section_ref: str,
) -> str:

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
            f'Run `structured_overview` or `search_structured`. Examples: {hint}'
        )

    json_body = render_section_json(section)
    out = format_section_detail(graph, section, json_body)
    return _truncate_output(out)
