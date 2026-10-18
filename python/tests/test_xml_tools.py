"""Tests for XML search-and-zoom tools."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from clara_coder_backend.session.state import current_session_id, get_session
from clara_coder_backend.xml.parser import clear_xml_cache_for_tests
from clara_coder_backend.tools.structured_tools import read_structured_section, search_structured, structured_overview

SAMPLE_XML = """<?xml version="1.0"?>
<Envelope xmlns="http://example.com/env">
  <Header>
    <MessageId>abc-123</MessageId>
  </Header>
  <Body>
    <GetCustomer id="42">
      <Name>Ada Lovelace</Name>
    </GetCustomer>
    <GetCustomer id="99">
      <Name>Grace Hopper</Name>
    </GetCustomer>
  </Body>
</Envelope>
"""


@pytest.fixture()
def xml_env():
    td = tempfile.TemporaryDirectory()
    root = Path(td.name)
    (root / 'service.xml').write_text(SAMPLE_XML, encoding='utf-8')

    session_id = 'test-xml-session'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.workspace_path = str(root.resolve())
    clear_xml_cache_for_tests()

    class _Env:
        pass

    env = _Env()
    env.root = root  # type: ignore[attr-defined]

    yield env

    clear_xml_cache_for_tests()
    current_session_id.reset(token)
    td.cleanup()


def test_xml_overview_lists_paths(xml_env) -> None:
    out = structured_overview.invoke({'relative_path': 'service.xml'})
    assert 'Root element: Envelope' in out
    assert '/Envelope/Body/GetCustomer' in out
    assert '/Envelope/Body/GetCustomer[2]' in out


def test_search_xml_finds_element(xml_env) -> None:
    out = search_structured.invoke(
        {'relative_path': 'service.xml', 'query': 'MessageId', 'scope': 'elements'}
    )
    assert 'section_ref=' in out
    assert 'MessageId' in out


def test_read_xml_section_returns_markup(xml_env) -> None:
    out = read_structured_section.invoke(
        {
            'relative_path': 'service.xml',
            'section_ref': 'path:/Envelope/Header/MessageId',
        }
    )
    assert 'MessageId' in out
    assert 'abc-123' in out


def test_wsdl_extension_routes_to_wsdl_reader(xml_env) -> None:
    (xml_env.root / 'svc.wsdl').write_text('<definitions/>', encoding='utf-8')
    out = structured_overview.invoke({'relative_path': 'svc.wsdl'})
    assert out.startswith('WSDL: svc.wsdl')


def test_xml_missing_file(xml_env) -> None:
    out = structured_overview.invoke({'relative_path': 'missing.xml'})
    assert 'not on the workspace disk' in out


def test_xml_invalid_section_ref(xml_env) -> None:
    out = read_structured_section.invoke(
        {'relative_path': 'service.xml', 'section_ref': 'operation:Bad'}
    )
    assert 'invalid `section_ref`' in out
