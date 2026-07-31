"""Constants for generic XML search-and-zoom tools."""

from __future__ import annotations

XML_EXTENSIONS = frozenset(
    {
        '.xml',
        '.xsd',
        '.xsl',
        '.xslt',
        '.svg',
        '.rss',
        '.atom',
        '.plist',
    }
)

WSDL_EXTENSION = '.wsdl'

SEARCH_SCOPES = frozenset({'all', 'elements', 'attributes', 'text'})

SECTION_REF_PREFIX = 'path:'
