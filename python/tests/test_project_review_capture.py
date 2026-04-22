"""Tests for nested final-review output capture."""

from __future__ import annotations

from nemo_backend.project_review_capture import (
    append_nested_review_command_output,
    nested_project_review_output_capture,
)
from nemo_backend.state import get_session


def test_append_nested_review_skips_when_capture_off() -> None:
    sid = 'cap-off'
    session = get_session(sid)
    session.last_project_review_subprocess_report = 'prior'
    append_nested_review_command_output(sid, 'npm script', 'out')
    assert session.last_project_review_subprocess_report == 'prior'


def test_append_nested_review_merges_when_capture_on() -> None:
    sid = 'cap-on'
    session = get_session(sid)
    session.last_project_review_subprocess_report = 'pytest tail'
    token = nested_project_review_output_capture.set(True)
    try:
        append_nested_review_command_output(sid, 'npm script summary', 'npm run test\n\nok')
        merged = session.last_project_review_subprocess_report
        assert 'pytest tail' in merged
        assert 'npm script summary' in merged
        assert 'npm run test' in merged
    finally:
        nested_project_review_output_capture.reset(token)
