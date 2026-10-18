"""Context pack registry, activation, and system-prompt catalog."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from clara_coder_backend.context_packs.activation import (
    activate_pack,
    maybe_activate_for_tool,
    relative_path_from_tool_args,
)
from clara_coder_backend.context_packs.registry import (
    ContextPack,
    format_context_catalog,
    get_pack,
    list_packs,
    packs_for_tool,
    register_pack,
)
from clara_coder_backend.context_packs.tool import ACTIVATE_CONTEXT_NAME, activate_context
from clara_coder_backend.llm.messages import build_system_prompt
from clara_coder_backend.domain import RuntimeConnection, SessionState
from clara_coder_backend.session.state import current_session_id, get_session

# Ensure built-ins are registered for this module.
import clara_coder_backend.context_packs  # noqa: F401


def _conn() -> RuntimeConnection:
    return RuntimeConnection(
        id='c',
        name='test',
        provider='openai',
        base_url='http://127.0.0.1:1234/v1',
        model='test-model',
        api_key='',
        reasoning_effort='',
        temperature=1.0,
        parallel_tool_calls=False,
        optimization_preset='generic',
        max_output_tokens=0,
    )


def test_builtin_packs_registered() -> None:
    ids = {p.id for p in list_packs()}
    assert {'json', 'pdf', 'wsdl', 'xml'}.issubset(ids)
    assert get_pack('wsdl') is not None


def test_packs_for_tool_structured_suffix_and_pdf_path() -> None:
    assert [p.id for p in packs_for_tool('structured_overview', relative_path='api/svc.wsdl')] == ['wsdl']
    assert [p.id for p in packs_for_tool('search_structured', relative_path='app.json')] == ['json']
    assert [p.id for p in packs_for_tool('read_structured_section', relative_path='a/b.xsd')] == ['xml']
    assert packs_for_tool('structured_overview') == []
    assert packs_for_tool('read_workspace_file', relative_path='docs/a.pdf')[0].id == 'pdf'
    assert packs_for_tool('read_workspace_file', relative_path='src/main.py') == []
    assert packs_for_tool('read_workspace_file') == []


def test_format_context_catalog_summaries_only() -> None:
    catalog = format_context_catalog()
    assert '`wsdl`' in catalog
    assert 'activate_context' in catalog
    wsdl = get_pack('wsdl')
    assert wsdl is not None
    assert wsdl.body not in catalog
    assert wsdl.summary in catalog


def test_auto_activate_once_then_unchanged() -> None:
    session = SessionState()
    first = maybe_activate_for_tool(session, 'structured_overview', 'OVERVIEW', relative_path='svc.wsdl')
    assert 'Context pack `wsdl`' in first
    assert 'OVERVIEW' in first
    assert 'wsdl' in session.activated_context_packs
    second = maybe_activate_for_tool(session, 'search_structured', 'SEARCH', relative_path='svc.wsdl')
    assert second == 'SEARCH'


def test_pdf_path_only_activates_pdf_pack() -> None:
    session = SessionState()
    plain = maybe_activate_for_tool(
        session, 'read_workspace_file', 'File: a.py\n', relative_path='a.py'
    )
    assert plain == 'File: a.py\n'
    assert 'pdf' not in session.activated_context_packs
    pdf = maybe_activate_for_tool(
        session, 'read_workspace_file', 'File: doc.pdf\n', relative_path='doc.pdf'
    )
    assert 'Context pack `pdf`' in pdf
    assert 'pdf' in session.activated_context_packs


def test_activate_pack_success_unknown_already_active() -> None:
    session = SessionState()
    body = activate_pack(session, 'xml')
    assert 'Context pack `xml`' in body
    again = activate_pack(session, 'xml')
    assert 'already active' in again
    unknown = activate_pack(session, 'nope')
    assert 'unknown context pack' in unknown
    assert '`pdf`' in unknown


def test_activate_context_tool_uses_session() -> None:
    sid = 'ctx-pack-activate-tool'
    token = current_session_id.set(sid)
    try:
        session = get_session(sid)
        session.activated_context_packs.clear()
        out = activate_context.invoke({'pack_id': 'json'})
        assert 'Context pack `json`' in out
        assert 'json' in session.activated_context_packs
    finally:
        current_session_id.reset(token)


def test_relative_path_from_tool_args() -> None:
    assert relative_path_from_tool_args({'relative_path': 'x.pdf'}) == 'x.pdf'
    assert relative_path_from_tool_args({}) is None


@patch('clara_coder_backend.llm.messages.get_active_connection')
def test_system_prompt_has_catalog_not_full_bodies(mock_conn: MagicMock) -> None:
    mock_conn.return_value = _conn()
    session = SessionState(workspace_path='/tmp/ws', workspace_context='.', auto_apply_mode=False)
    prompt = build_system_prompt(session, apply_mode=False)
    assert 'Context packs' in prompt
    assert '`wsdl`' in prompt
    assert ACTIVATE_CONTEXT_NAME in prompt
    # Deep playbook bullets removed from always-on operational text
    assert 'prefer `wsdl_overview` → `search_wsdl`' not in prompt
    wsdl = get_pack('wsdl')
    assert wsdl is not None
    assert wsdl.body not in prompt


def test_register_pack_extension_point() -> None:
    pack_id = 'demo_ctx_pack_test'
    register_pack(
        ContextPack(
            id=pack_id,
            summary='demo pack',
            body='demo body',
            tool_prefixes=('demo_ctx_',),
        )
    )
    try:
        assert get_pack(pack_id) is not None
        assert any(p.id == pack_id for p in packs_for_tool('demo_ctx_run'))
    finally:
        # Leave registry usable for later tests: overwrite with a noop tombstone removal
        # by re-registering is fine; drop via private map for cleanliness.
        from clara_coder_backend.context_packs import registry as reg

        reg._PACKS.pop(pack_id, None)
