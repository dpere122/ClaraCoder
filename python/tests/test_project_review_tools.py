from __future__ import annotations

from clara_coder_backend.tools.project_review_tools import RollingTextBuffer


def test_rolling_text_buffer_drops_oldest_past_cap() -> None:
    buf = RollingTextBuffer(max_chars=10)
    buf.append('abcdefghij')
    assert buf.as_str() == 'abcdefghij'
    buf.append('XYZ')
    assert len(buf.as_str()) == 10
    assert buf.as_str() == 'defghijXYZ'
    buf.append('12345')
    assert len(buf.as_str()) == 10
    assert buf.as_str().endswith('12345')


def test_rolling_text_buffer_ignores_empty() -> None:
    buf = RollingTextBuffer(max_chars=5)
    buf.append('')
    buf.append('hi')
    assert buf.as_str() == 'hi'
