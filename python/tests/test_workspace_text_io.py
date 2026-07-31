"""Tests for workspace text encoding and newline helpers."""

import tempfile
from pathlib import Path

import pytest

from clara_coder_backend.workspace_text_io import (
    decode_for_tools,
    detect_newline_preference,
    encode_for_disk,
    normalize_encoding,
    parse_newline_mode,
    read_file_for_tools,
    resolve_newline_for_write,
    validate_workspace_encoding,
    write_file_resolved,
    write_file_to_disk,
)


def test_normalize_encoding_aliases() -> None:
    assert normalize_encoding('UTF8') == 'utf-8'
    assert normalize_encoding('windows-1252') == 'cp1252'


def test_validate_allowlist() -> None:
    assert validate_workspace_encoding('latin-1') == 'latin-1'
    with pytest.raises(ValueError):
        validate_workspace_encoding('utf-7')


def test_validate_language_or_ext_mistaken_for_encoding_defaults_to_utf8() -> None:
    """Models sometimes pass file type (e.g. css) where a codec name is required."""
    assert validate_workspace_encoding('css') == 'utf-8'
    assert validate_workspace_encoding('CSS') == 'utf-8'
    assert validate_workspace_encoding('html') == 'utf-8'


def test_decode_normalizes_newlines() -> None:
    raw = b'a\r\nb\nc'
    text = decode_for_tools(raw, 'utf-8')
    assert text == 'a\nb\nc'


def test_detect_newline_preference() -> None:
    assert detect_newline_preference(b'x') == 'lf'
    assert detect_newline_preference(b'a\r\nb') == 'crlf'
    assert detect_newline_preference(b'a\nb') == 'lf'


def test_parse_newline_mode() -> None:
    assert parse_newline_mode('crlf') == 'crlf'
    assert parse_newline_mode('preserve') == 'preserve'
    assert parse_newline_mode('unknown') == 'lf'


def test_resolve_preserve_new_file() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / 'new.txt'
        assert resolve_newline_for_write('preserve', path=p, raw_existing=None) == 'lf'


def test_crlf_round_trip_via_bytes() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / 'f.txt'
        p.write_bytes(b'line1\r\nline2\r\n')
        text = read_file_for_tools(p, 'utf-8')
        assert text == 'line1\nline2\n'
        disk_nl = resolve_newline_for_write('preserve', path=p, raw_existing=p.read_bytes())
        assert disk_nl == 'crlf'
        write_file_resolved(p, text, 'utf-8', disk_nl)
        assert p.read_bytes() == b'line1\r\nline2\r\n'


def test_write_file_to_disk_lf() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / 'x.txt'
        write_file_to_disk(p, 'a\nb', 'utf-8', 'lf')
        assert p.read_bytes() == b'a\nb'


def test_encode_cp1252_round_trip() -> None:
    raw = encode_for_disk('café', 'cp1252', 'lf')
    assert b'\xe9' in raw
    back = decode_for_tools(raw, 'cp1252')
    assert back == 'café'


def test_encode_strict_rejects_surrogate() -> None:
    with pytest.raises(UnicodeEncodeError):
        encode_for_disk('\ud800', 'ascii', 'lf')
