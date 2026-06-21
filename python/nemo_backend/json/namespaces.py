"""Constants for JSON search-and-zoom tools."""

from __future__ import annotations

JSON_EXTENSIONS = frozenset({'.json', '.jsonc'})

SEARCH_SCOPES = frozenset({'all', 'keys', 'values'})

SECTION_REF_PREFIX = 'path:'
