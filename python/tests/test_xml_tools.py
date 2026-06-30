"""Tests for XML search-and-zoom tools."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from nemo_backend.state import current_session_id, get_session
from nemo_backend.xml.parser import clear_xml_cache_for_tests
from nemo_backend.tools.xml_tools import read_xml_section, search_xml, xml_overview

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
    out = xml_overview.invoke({'relative_path': 'service.xml'})
    assert 'Root element: Envelope' in out
    assert '/Envelope/Body/GetCustomer' in out
    assert '/Envelope/Body/GetCustomer[2]' in out


def test_search_xml_finds_element(xml_env) -> None:
    out = search_xml.invoke(
        {'relative_path': 'service.xml', 'query': 'MessageId', 'scope': 'elements'}
    )
    assert 'section_ref=' in out
    assert 'MessageId' in out


def test_read_xml_section_returns_markup(xml_env) -> None:
    out = read_xml_section.invoke(
        {
            'relative_path': 'service.xml',
            'section_ref': 'path:/Envelope/Header/MessageId',
        }
    )
    assert 'MessageId' in out
    assert 'abc-123' in out


def test_xml_rejects_wsdl_extension(xml_env) -> None:
    (xml_env.root / 'svc.wsdl').write_text('<definitions/>', encoding='utf-8')
    out = xml_overview.invoke({'relative_path': 'svc.wsdl'})
    assert 'wsdl_overview' in out


def test_xml_missing_file(xml_env) -> None:
    out = xml_overview.invoke({'relative_path': 'missing.xml'})
    assert 'not on the workspace disk' in out


def test_xml_invalid_section_ref(xml_env) -> None:
    out = read_xml_section.invoke(
        {'relative_path': 'service.xml', 'section_ref': 'operation:Bad'}
    )
    assert 'invalid `section_ref`' in out
