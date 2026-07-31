"""LangChain tools for generic XML search-and-zoom reading."""

from __future__ import annotations

from typing import Annotated

from langchain_core.tools import tool

from clara_coder_backend.state import runtime_config
from clara_coder_backend.tools.tool_conventions import RELATIVE_PATH, describe
from clara_coder_backend.xml.format import format_search_results, format_section_detail, format_xml_overview
from clara_coder_backend.xml.namespaces import SEARCH_SCOPES
from clara_coder_backend.xml.parser import (
    build_xml_graph,
    parse_section_ref,
    render_section_xml,
    resolve_xml_path,
    search_sections,
)

XML_OVERVIEW_NAME = 'xml_overview'
SEARCH_XML_NAME = 'search_xml'
READ_XML_SECTION_NAME = 'read_xml_section'

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


def _load_graph(relative_path: str):
    root = _workspace_root()
    target, err = resolve_xml_path(root, relative_path)
    if err or target is None:
        return None, None, err
    rel_display = target.relative_to(root.resolve()).as_posix()
    graph = build_xml_graph(root.resolve(), target, rel_display)
    if graph.parse_error:
        return None, rel_display, f'could not parse XML `{rel_display}`: {graph.parse_error}'
    return graph, rel_display, None


@tool(XML_OVERVIEW_NAME, description=describe(
        'Index a generic XML file by element paths (root, tree outline, node count).',
        when='starting work on `.xml`/`.xsd`/`.xsl`/`.svg`/etc.; need structure before raw reads.',
        not_='`.wsdl` SOAP contracts (use `wsdl_overview`); fuzzy file discovery (use `search_workspace`).',
        shape=(
            f'`relative_path` {RELATIVE_PATH} XML path. Returns `section_ref` values like `path:/root/child`. '
            'Next: `search_xml` or `read_xml_section`.'
        ),
    ))
def xml_overview(relative_path: Annotated[str, 'workspace-relative POSIX path']) -> str:

    graph, rel_display, err = _load_graph(relative_path)
    if err:
        return f'Tool note: {err}'
    assert graph is not None
    return _truncate_output(format_xml_overview(graph))


@tool(SEARCH_XML_NAME, description=describe(
        'Search indexed XML by element name, path, attribute, or text snippet (case-insensitive).',
        when='locating nodes after `xml_overview`.',
        not_='repo-wide file discovery; `.wsdl` (use `search_wsdl`).',
        shape='`scope` one of all|elements|attributes|text. Returns `section_ref` for zoom. '
        'Next: `read_xml_section(relative_path, section_ref)`.',
    ))
def search_xml(
    relative_path: Annotated[str, 'workspace-relative POSIX path'],
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


@tool(READ_XML_SECTION_NAME, description=describe(
        'Zoom into one XML element by `section_ref` (pretty-printed XML snippet).',
        when='you have `section_ref` from `xml_overview` or `search_xml`.',
        not_='first pass on unknown XML (use `xml_overview` first).',
        shape='`section_ref` like `path:/Envelope/Body/GetCustomer` or `path:/root/item[2]`.',
    ))
def read_xml_section(
    relative_path: Annotated[str, 'workspace-relative POSIX path'],
    section_ref: Annotated[str, 'from *_overview or search_*'],
) -> str:

    graph, _rel_display, err = _load_graph(relative_path)
    if err:
        return f'Tool note: {err}'
    assert graph is not None

    ref_key = parse_section_ref(section_ref)
    if ref_key is None:
        return (
            'Tool note: invalid `section_ref`. Expected `path:/Root/child` '
            '(leading slash, optional `[n]` for duplicate siblings).'
        )

    section = graph.sections.get(ref_key)
    if section is None:
        known = graph.section_refs()[:20]
        hint = ', '.join(known) if known else '(none indexed)'
        return (
            f'Tool note: section_ref `{section_ref}` not found. '
            f'Run `xml_overview` or `search_xml`. Examples: {hint}'
        )

    xml_body = render_section_xml(section)
    out = format_section_detail(graph, section, xml_body)
    return _truncate_output(out)


XML_TOOLS = [xml_overview, search_xml, read_xml_section]
