"""WSDL 1.1 / SOAP / XSD namespace helpers."""

from __future__ import annotations

WSDL_NS = 'http://schemas.xmlsoap.org/wsdl/'
SOAP_NS = 'http://schemas.xmlsoap.org/wsdl/soap/'
XSD_NS = 'http://www.w3.org/2001/XMLSchema'

WSDL_IMPORT = f'{{{WSDL_NS}}}import'
WSDL_TYPES = f'{{{WSDL_NS}}}types'
WSDL_MESSAGE = f'{{{WSDL_NS}}}message'
WSDL_PART = f'{{{WSDL_NS}}}part'
WSDL_PORT_TYPE = f'{{{WSDL_NS}}}portType'
WSDL_OPERATION = f'{{{WSDL_NS}}}operation'
WSDL_INPUT = f'{{{WSDL_NS}}}input'
WSDL_OUTPUT = f'{{{WSDL_NS}}}output'
WSDL_FAULT = f'{{{WSDL_NS}}}fault'
WSDL_BINDING = f'{{{WSDL_NS}}}binding'
WSDL_SERVICE = f'{{{WSDL_NS}}}service'
WSDL_PORT = f'{{{WSDL_NS}}}port'
WSDL_DEFINITIONS = f'{{{WSDL_NS}}}definitions'

XSD_IMPORT = f'{{{XSD_NS}}}import'
XSD_INCLUDE = f'{{{XSD_NS}}}include'
XSD_SCHEMA = f'{{{XSD_NS}}}schema'
XSD_ELEMENT = f'{{{XSD_NS}}}element'
XSD_COMPLEX_TYPE = f'{{{XSD_NS}}}complexType'
XSD_SIMPLE_TYPE = f'{{{XSD_NS}}}simpleType'

SOAP_BINDING = f'{{{SOAP_NS}}}binding'
SOAP_OPERATION = f'{{{SOAP_NS}}}operation'
SOAP_BODY = f'{{{SOAP_NS}}}body'

SECTION_KINDS = frozenset(
    {
        'service',
        'port',
        'portType',
        'operation',
        'message',
        'binding',
        'binding_op',
        'type',
        'element',
    }
)

SEARCH_SCOPES = frozenset(
    {
        'all',
        'services',
        'operations',
        'messages',
        'bindings',
        'types',
    }
)


def local_name(tag: str) -> str:
    """Return the local part of a Clark notation tag."""
    if tag.startswith('{'):
        closing = tag.find('}')
        if closing != -1:
            return tag[closing + 1 :]
    return tag


def qname_tag(ns_uri: str, local: str) -> str:
    return f'{{{ns_uri}}}{local}'


def iter_children(parent, local: str):
    """Yield direct children whose local name matches ``local``."""
    for child in parent:
        if local_name(child.tag) == local:
            yield child
