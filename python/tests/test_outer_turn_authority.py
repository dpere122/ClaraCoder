"""Session-truth preamble prepended to outer Clara turns."""

from __future__ import annotations

from clara_coder_backend.domain import SessionState
from clara_coder_backend.messages import compose_outer_turn_human_content, outer_turn_authority_preamble


def test_outer_turn_authority_preamble_reflects_live_flags() -> None:
    session = SessionState()
    session.auto_apply_mode = True
    session.active_editor_langgraph_streams = 1
    text = outer_turn_authority_preamble(session, apply_mode=True)
    assert 'Editor (toolbar, this turn): **on**' in text
    assert 'Auto-apply (UI): **on**' in text
    assert 'Other concurrent Editor streams' in text


def test_outer_turn_authority_preamble_editor_off_branch() -> None:
    session = SessionState()
    session.auto_apply_mode = False
    session.active_editor_langgraph_streams = 0
    text = outer_turn_authority_preamble(session, apply_mode=False)
    assert 'Editor (toolbar, this turn): **off**' in text


def test_compose_outer_turn_human_content_string() -> None:
    session = SessionState()
    out = compose_outer_turn_human_content(session, True, 'Do the thing')
    assert isinstance(out, str)
    assert out.startswith('**Session truth')
    assert out.endswith('Do the thing')


def test_compose_outer_turn_human_content_multimodal_text_first() -> None:
    session = SessionState()
    out = compose_outer_turn_human_content(
        session,
        False,
        [{'type': 'text', 'text': 'User body'}],
    )
    assert isinstance(out, list)
    assert out[0]['type'] == 'text'
    assert str(out[0]['text']).startswith('**Session truth')
    assert 'User body' in str(out[0]['text'])


def test_compose_outer_turn_human_content_multimodal_inserts_text_block() -> None:
    session = SessionState()
    out = compose_outer_turn_human_content(
        session,
        True,
        [{'type': 'image_url', 'image_url': {'url': 'http://example.com/x'}}],
    )
    assert isinstance(out, list)
    assert len(out) == 2
    assert out[0]['type'] == 'text'
    assert str(out[0]['text']).startswith('**Session truth')


def test_compose_outer_turn_human_content_empty_list_is_preamble_only() -> None:
    session = SessionState()
    preamble = outer_turn_authority_preamble(session, True)
    out = compose_outer_turn_human_content(session, True, [])
    assert out == [{'type': 'text', 'text': preamble}]
