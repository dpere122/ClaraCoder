"""Tests for WSDL search-and-zoom tools."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from nemo_backend.state import current_session_id, get_session
from nemo_backend.wsdl.parser import clear_wsdl_cache_for_tests
from nemo_backend.wsdl.tools import read_wsdl_section, search_wsdl, wsdl_overview
MINIMAL_WSDL = """<?xml version="1.0"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
             xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
             xmlns:tns="http://example.com/customer"
             xmlns:xsd="http://www.w3.org/2001/XMLSchema"
             targetNamespace="http://example.com/customer"
             name="CustomerService">
  <types>
    <xsd:schema targetNamespace="http://example.com/customer">
      <xsd:element name="GetCustomerRequest" type="xsd:string"/>
      <xsd:complexType name="CustomerType">
        <xsd:sequence>
          <xsd:element name="id" type="xsd:string"/>
        </xsd:sequence>
      </xsd:complexType>
    </xsd:schema>
  </types>
  <message name="GetCustomerRequest">
    <part name="body" element="tns:GetCustomerRequest"/>
  </message>
  <message name="GetCustomerResponse">
    <part name="body" element="tns:CustomerType"/>
  </message>
  <portType name="CustomerPortType">
    <operation name="GetCustomer">
      <input message="tns:GetCustomerRequest"/>
      <output message="tns:GetCustomerResponse"/>
    </operation>
  </portType>
  <binding name="CustomerBinding" type="tns:CustomerPortType">
    <soap:binding transport="http://schemas.xmlsoap.org/soap/http" style="document"/>
    <operation name="GetCustomer">
      <soap:operation soapAction="http://example.com/GetCustomer"/>
      <input><soap:body use="literal"/></input>
      <output><soap:body use="literal"/></output>
    </operation>
  </binding>
  <service name="CustomerService">
    <port name="HTTPPort" binding="tns:CustomerBinding">
      <soap:address location="http://example.com/customer"/>
    </port>
  </service>
</definitions>
"""

IMPORTED_XSD = """<?xml version="1.0"?>
<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema"
            targetNamespace="http://example.com/imported">
  <xsd:complexType name="ImportedType">
    <xsd:sequence>
      <xsd:element name="value" type="xsd:string"/>
    </xsd:sequence>
  </xsd:complexType>
</xsd:schema>
"""

IMPORTING_WSDL = """<?xml version="1.0"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
             xmlns:xsd="http://www.w3.org/2001/XMLSchema"
             targetNamespace="http://example.com/imported"
             name="ImportService">
  <types>
    <xsd:schema targetNamespace="http://example.com/imported">
      <xsd:import namespace="http://example.com/imported"
                  schemaLocation="types/types.xsd"/>
    </xsd:schema>
  </types>
  <message name="PingRequest"/>
  <portType name="ImportPortType">
    <operation name="Ping">
      <input message="tns:PingRequest"/>
    </operation>
  </portType>
</definitions>
"""


@pytest.fixture()
def wsdl_env():
    td = tempfile.TemporaryDirectory()
    root = Path(td.name)
    (root / 'service.wsdl').write_text(MINIMAL_WSDL, encoding='utf-8')

    import_dir = root / 'imported'
    import_dir.mkdir()
    types_dir = import_dir / 'types'
    types_dir.mkdir()
    (types_dir / 'types.xsd').write_text(IMPORTED_XSD, encoding='utf-8')
    (import_dir / 'main.wsdl').write_text(IMPORTING_WSDL, encoding='utf-8')

    session_id = 'test-wsdl-session'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.workspace_path = str(root.resolve())
    clear_wsdl_cache_for_tests()

    class _Env:
        pass

    env = _Env()
    env.root = root  # type: ignore[attr-defined]

    yield env

    clear_wsdl_cache_for_tests()
    current_session_id.reset(token)
    td.cleanup()


def test_wsdl_overview_lists_core_sections(wsdl_env) -> None:
    out = wsdl_overview.invoke({'relative_path': 'service.wsdl'})
    assert 'CustomerService' in out
    assert 'section_ref=service:CustomerService' not in out
    assert 'service:CustomerService' in out
    assert 'operation:CustomerPortType/GetCustomer' in out
    assert 'message:GetCustomerRequest' in out
    assert 'binding:CustomerBinding' in out
    assert 'type:CustomerType' in out
    assert 'element:GetCustomerRequest' in out


def test_search_wsdl_finds_operation(wsdl_env) -> None:
    out = search_wsdl.invoke(
        {'relative_path': 'service.wsdl', 'query': 'GetCustomer', 'scope': 'operations'}
    )
    assert 'section_ref=' in out
    assert 'operation:CustomerPortType/GetCustomer' in out


def test_read_wsdl_section_returns_xml(wsdl_env) -> None:
    out = read_wsdl_section.invoke(
        {
            'relative_path': 'service.wsdl',
            'section_ref': 'operation:CustomerPortType/GetCustomer',
        }
    )
    assert 'WSDL section: operation:CustomerPortType/GetCustomer' in out
    assert 'GetCustomer' in out
    assert '<operation' in out or 'operation' in out


def test_read_wsdl_section_message_and_type(wsdl_env) -> None:
    msg_out = read_wsdl_section.invoke(
        {'relative_path': 'service.wsdl', 'section_ref': 'message:GetCustomerRequest'}
    )
    assert 'message:GetCustomerRequest' in msg_out
    assert 'GetCustomerRequest' in msg_out

    type_out = read_wsdl_section.invoke(
        {'relative_path': 'service.wsdl', 'section_ref': 'type:CustomerType'}
    )
    assert 'type:CustomerType' in type_out
    assert 'CustomerType' in type_out


def test_wsdl_import_indexes_imported_type(wsdl_env) -> None:
    out = wsdl_overview.invoke({'relative_path': 'imported/main.wsdl', 'import_depth': 1})
    assert 'imported/types/types.xsd' in out
    assert 'type:ImportedType' in out

    search_out = search_wsdl.invoke(
        {'relative_path': 'imported/main.wsdl', 'query': 'ImportedType', 'scope': 'types'}
    )
    assert 'type:ImportedType' in search_out


def test_wsdl_missing_file(wsdl_env) -> None:
    out = wsdl_overview.invoke({'relative_path': 'missing.wsdl'})
    assert 'not on the workspace disk' in out


def test_wsdl_non_wsdl_extension(wsdl_env) -> None:
    (wsdl_env.root / 'notes.txt').write_text('hello', encoding='utf-8')
    out = wsdl_overview.invoke({'relative_path': 'notes.txt'})
    assert 'must end with .wsdl' in out


def test_wsdl_invalid_section_ref(wsdl_env) -> None:
    out = read_wsdl_section.invoke(
        {'relative_path': 'service.wsdl', 'section_ref': 'not-a-valid-ref'}
    )
    assert 'invalid `section_ref`' in out


def test_wsdl_unknown_section_ref(wsdl_env) -> None:
    out = read_wsdl_section.invoke(
        {'relative_path': 'service.wsdl', 'section_ref': 'operation:Missing/Op'}
    )
    assert 'not found' in out


def test_wsdl_path_escape_blocked(wsdl_env) -> None:
    out = wsdl_overview.invoke({'relative_path': '../outside.wsdl'})
    assert 'outside the active workspace' in out
