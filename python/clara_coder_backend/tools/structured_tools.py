"""Search-and-zoom tools for structured files: one tool set, dispatched to a WSDL, XML or JSON backend by extension.

The per-format backends live in :mod:`~clara_coder_backend.tools.wsdl_tools`,
:mod:`~clara_coder_backend.tools.xml_tools` and :mod:`~clara_coder_backend.tools.json_tools`. The matching
context pack (``wsdl`` / ``xml`` / ``json``) auto-activates on first use for that file type.
"""

from __future__ import annotations

from pathlib import PurePosixPath
from typing import Annotated, Any

from langchain_core.tools import tool

from clara_coder_backend.json.namespaces import JSON_EXTENSIONS
from clara_coder_backend.tools import json_tools, wsdl_tools, xml_tools
from clara_coder_backend.tools.tool_conventions import RELATIVE_PATH, describe
from clara_coder_backend.xml.namespaces import WSDL_EXTENSION, XML_EXTENSIONS

STRUCTURED_OVERVIEW_NAME = 'structured_overview'
SEARCH_STRUCTURED_NAME = 'search_structured'
READ_STRUCTURED_SECTION_NAME = 'read_structured_section'

_DEFAULT_IMPORT_DEPTH = 1
_SUPPORTED = ', '.join(sorted({WSDL_EXTENSION, *XML_EXTENSIONS, *JSON_EXTENSIONS}))
_IMPORT_DEPTH_HINT = 'WSDL only: follow wsdl/xs imports 0–3'

__all__ = [
    'READ_STRUCTURED_SECTION_NAME',
    'SEARCH_STRUCTURED_NAME',
    'STRUCTURED_OVERVIEW_NAME',
    'STRUCTURED_TOOLS',
    'read_structured_section',
    'search_structured',
    'structured_overview',
]


def _backend(relative_path: str) -> Any | None:
    suffix = PurePosixPath((relative_path or '').strip().replace('\\', '/')).suffix.lower()
    if suffix == WSDL_EXTENSION:
        return wsdl_tools
    if suffix in JSON_EXTENSIONS:
        return json_tools
    if suffix in XML_EXTENSIONS:
        return xml_tools
    return None


def _unsupported(relative_path: str) -> str:
    return f'Tool note: `{relative_path}` is not a structured file this reader handles ({_SUPPORTED}).'


@tool(
    STRUCTURED_OVERVIEW_NAME,
    description=describe(
        'Index a WSDL, XML-family or JSON file into an outline with `section_ref` handles',
        when=f'starting on {_SUPPORTED} before any raw read',
        not_='finding which file to open (use `search_workspace`)',
        shape='then `search_structured` for names/values or `read_structured_section` to zoom',
    ),
)
def structured_overview(
    relative_path: Annotated[str, RELATIVE_PATH],
    import_depth: Annotated[int, _IMPORT_DEPTH_HINT] = _DEFAULT_IMPORT_DEPTH,
) -> str:
    backend = _backend(relative_path)
    if backend is wsdl_tools:
        return wsdl_tools.wsdl_overview(relative_path, import_depth)
    if backend is json_tools:
        return json_tools.json_overview(relative_path)
    if backend is xml_tools:
        return xml_tools.xml_overview(relative_path)
    return _unsupported(relative_path)


@tool(
    SEARCH_STRUCTURED_NAME,
    description=describe(
        'Search an indexed structured file by name, path or value (case-insensitive); returns `section_ref`s',
        when='locating a symbol, element, key or value after `structured_overview`',
        not_='repo-wide search (use `search_workspace`)',
        shape=(
            '`scope`: WSDL all|services|operations|messages|bindings|types; XML all|elements|attributes|text; '
            'JSON all|keys|values'
        ),
    ),
)
def search_structured(
    relative_path: Annotated[str, RELATIVE_PATH],
    query: Annotated[str, 'name, path fragment or value'],
    scope: Annotated[str, 'format-specific filter; default all'] = 'all',
    max_matches: Annotated[int, 'cap on returned matches'] = 20,
    import_depth: Annotated[int, _IMPORT_DEPTH_HINT] = _DEFAULT_IMPORT_DEPTH,
) -> str:
    backend = _backend(relative_path)
    if backend is wsdl_tools:
        return wsdl_tools.search_wsdl(relative_path, query, scope, max_matches, import_depth)
    if backend is json_tools:
        return json_tools.search_json(relative_path, query, scope, max_matches)
    if backend is xml_tools:
        return xml_tools.search_xml(relative_path, query, scope, max_matches)
    return _unsupported(relative_path)


@tool(
    READ_STRUCTURED_SECTION_NAME,
    description=describe(
        'Zoom into one section of a structured file by `section_ref` (pretty-printed)',
        when='you have a `section_ref` from `structured_overview` or `search_structured`',
        shape='refs look like `operation:PortType/Op` (WSDL), `path:/root/child` (XML), `path:items[0].sku` (JSON)',
    ),
)
def read_structured_section(
    relative_path: Annotated[str, RELATIVE_PATH],
    section_ref: Annotated[str, 'from structured_overview / search_structured'],
    import_depth: Annotated[int, _IMPORT_DEPTH_HINT] = _DEFAULT_IMPORT_DEPTH,
) -> str:
    backend = _backend(relative_path)
    if backend is wsdl_tools:
        return wsdl_tools.read_wsdl_section(relative_path, section_ref, import_depth)
    if backend is json_tools:
        return json_tools.read_json_section(relative_path, section_ref)
    if backend is xml_tools:
        return xml_tools.read_xml_section(relative_path, section_ref)
    return _unsupported(relative_path)


STRUCTURED_TOOLS: list[Any] = [structured_overview, search_structured, read_structured_section]
