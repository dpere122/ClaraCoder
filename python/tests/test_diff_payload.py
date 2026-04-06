"""Tests for diff payload build and verify behavior."""

from unittest.mock import MagicMock, patch

from nemo_backend.diff_payload import build_file_diff_payload


def test_builds_small_change() -> None:
    payload, err = build_file_diff_payload('a.ts', 'one\ntwo\n', 'one\nTWO\n')
    assert err is None
    assert payload is not None
    assert payload['fullNewContent'] == 'one\nTWO\n'
    assert payload.get('diskEncoding') == 'utf-8'
    assert payload.get('diskNewline') == 'lf'
    kinds = [r['kind'] for r in payload['rows']]
    assert kinds == ['equal', 'replace']


def test_repeated_context_lines_middle_replace() -> None:
    """Line-mode DMP + cleanup keeps a single replace row when editing the middle of repeated lines."""
    old = 'a\na\na\n'
    new = 'a\nb\na\n'
    payload, err = build_file_diff_payload('x.txt', old, new)
    assert err is None
    assert payload is not None
    assert [r['kind'] for r in payload['rows']] == ['equal', 'replace', 'equal']


@patch('nemo_backend.diff_payload._verify_patch', return_value=False)
def test_builds_when_patch_verify_fails(_mock_verify: MagicMock) -> None:
    payload, err = build_file_diff_payload('a.ts', 'x\n', 'y\n')
    assert err is None
    assert payload is not None
    assert payload['fullNewContent'] == 'y\n'


def test_disk_metadata_pass_through() -> None:
    payload, err = build_file_diff_payload(
        'x.txt',
        'a\n',
        'b\n',
        disk_encoding='cp1252',
        disk_newline='crlf',
    )
    assert err is None
    assert payload is not None
    assert payload['diskEncoding'] == 'cp1252'
    assert payload['diskNewline'] == 'crlf'


def test_invalid_disk_newline() -> None:
    _payload, err = build_file_diff_payload('x.txt', 'a', 'b', disk_newline='preserve')
    assert err is not None


@patch('nemo_backend.diff_payload.DIFF_VERIFY_PATCH_MAX_BYTES', 8)
def test_skips_verify_when_over_byte_limit() -> None:
    old = 'a' * 20
    new = 'b' * 20
    payload, err = build_file_diff_payload('big.txt', old, new)
    assert err is None
    assert payload is not None
    assert payload['fullNewContent'] == new
