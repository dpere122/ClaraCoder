"""Tests for workspace string truncation helpers."""

from nemo_backend.workspace_tools import truncate_text_head_tail


def test_truncate_text_head_tail_keeps_start_and_end() -> None:
    head = 'A' * 500
    middle = 'B' * 10_000
    tail = 'Z' * 500
    text = head + middle + tail
    out = truncate_text_head_tail(text, 2000)
    assert out.startswith('AAA')
    assert 'truncated middle' in out
    assert out.endswith('ZZZ')
    assert len(out) <= 2000


def test_truncate_text_head_tail_noop_when_short() -> None:
    s = 'hello'
    assert truncate_text_head_tail(s, 100) == s
