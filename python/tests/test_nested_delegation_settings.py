"""Nested delegation snapshot and mutation authorization."""

from __future__ import annotations

from nemo_backend.domain import SessionState
from nemo_backend.prompt_blocks import nested_authoritative_settings_banner
from nemo_backend.state import mutation_tools_blocked_reason


def test_mutation_tools_blocked_when_editor_off() -> None:
    from nemo_backend.state import get_session

    sid = 'test-mutation-blocked'
    sess = get_session(sid)
    sess.worker_apply_mode = False
    sess.nested_turn_apply_mode = None
    err = mutation_tools_blocked_reason(sid)
    assert err is not None
    assert 'Editor mode is off' in (err or '')


def test_mutation_tools_allowed_when_nested_snapshot_on() -> None:
    from nemo_backend.state import get_session

    sid = 'test-mutation-nested-on'
    sess = get_session(sid)
    sess.worker_apply_mode = False
    sess.nested_turn_apply_mode = True
    assert mutation_tools_blocked_reason(sid) is None


def test_nested_authoritative_settings_banner_empty_without_snapshot() -> None:
    s = SessionState()
    assert nested_authoritative_settings_banner(s) == ''


def test_nested_authoritative_settings_banner_non_empty() -> None:
    s = SessionState()
    s.nested_turn_apply_mode = True
    s.nested_turn_auto_apply_mode = False
    s.nested_turn_orchestrated_mode = True
    text = nested_authoritative_settings_banner(s)
    assert 'Editor' in text and 'ON' in text
    assert 'Orchestrated' in text.lower() or 'on' in text.lower()
    assert 'Auto-apply' in text or 'auto' in text.lower()
