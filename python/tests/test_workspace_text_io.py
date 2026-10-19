"""Tests for workspace text encoding and newline helpers."""

import os
import stat
import tempfile
from pathlib import Path

import pytest

from clara_coder_backend.workspace import workspace_text_io
from clara_coder_backend.workspace.workspace_text_io import (
    ATOMIC_WRITE_TEMP_SUFFIX,
    SEARCH_MAX_FILE_BYTES,
    decode_for_tools,
    detect_newline_preference,
    encode_for_disk,
    normalize_encoding,
    parse_newline_mode,
    read_file_for_search_tools,
    read_file_for_tools,
    resolve_newline_for_write,
    validate_workspace_encoding,
    write_bytes_atomic,
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


def test_read_file_for_search_tools_reads_small_file(tmp_path: Path) -> None:
    p = tmp_path / 'ok.py'
    p.write_text('alpha\r\nbeta\n', encoding='utf-8')
    text = read_file_for_search_tools(p, 'utf-8')
    assert text == 'alpha\nbeta\n'


def test_read_file_for_search_tools_skips_oversized(tmp_path: Path) -> None:
    p = tmp_path / 'big.bin'
    p.write_bytes(b'a' * (SEARCH_MAX_FILE_BYTES + 1))
    assert read_file_for_search_tools(p, 'utf-8') is None
    assert read_file_for_search_tools(p, 'utf-8', max_bytes=8) is None


def test_read_file_for_search_tools_skips_empty_and_binary(tmp_path: Path) -> None:
    empty = tmp_path / 'empty.txt'
    empty.write_bytes(b'')
    assert read_file_for_search_tools(empty, 'utf-8') is None

    binary = tmp_path / 'bin.dat'
    binary.write_bytes(b'abc\x00def')
    assert read_file_for_search_tools(binary, 'utf-8') is None


def test_atomic_write_replaces_content_and_leaves_no_temp_file(tmp_path: Path) -> None:
    p = tmp_path / 'f.txt'
    p.write_bytes(b'old')
    write_bytes_atomic(p, b'new')
    assert p.read_bytes() == b'new'
    assert [c.name for c in tmp_path.iterdir()] == ['f.txt']


@pytest.mark.skipif(os.name == 'nt', reason='POSIX permission bits')
def test_atomic_write_keeps_permission_bits(tmp_path: Path) -> None:
    p = tmp_path / 'run.sh'
    p.write_bytes(b'#!/bin/sh\n')
    p.chmod(0o755)
    write_bytes_atomic(p, b'#!/bin/sh\necho hi\n')
    assert stat.S_IMODE(p.stat().st_mode) == 0o755


def test_atomic_write_goes_through_a_symlink(tmp_path: Path) -> None:
    real = tmp_path / 'real.txt'
    real.write_bytes(b'old')
    link = tmp_path / 'link.txt'
    try:
        link.symlink_to(real)
    except OSError:
        pytest.skip('symlinks need extra privileges here')
    write_bytes_atomic(link, b'new')
    assert link.is_symlink()
    assert real.read_bytes() == b'new'


def test_atomic_write_refuses_a_read_only_file(tmp_path: Path) -> None:
    p = tmp_path / 'ro.txt'
    p.write_bytes(b'old')
    p.chmod(stat.S_IREAD)
    try:
        with pytest.raises(PermissionError):
            write_bytes_atomic(p, b'new')
        assert p.read_bytes() == b'old'
    finally:
        p.chmod(stat.S_IREAD | stat.S_IWRITE)


def test_atomic_write_falls_back_to_in_place_when_rename_stays_blocked(tmp_path: Path, monkeypatch) -> None:
    p = tmp_path / 'locked.txt'
    p.write_bytes(b'old')
    attempts = []

    def blocked_replace(src, dst):
        attempts.append(src)
        raise PermissionError(13, 'file in use')

    monkeypatch.setattr(workspace_text_io.os, 'replace', blocked_replace)
    monkeypatch.setattr(workspace_text_io.time, 'sleep', lambda _s: None)
    write_bytes_atomic(p, b'new')
    assert p.read_bytes() == b'new'
    assert len(attempts) == 5
    assert [c.name for c in tmp_path.iterdir()] == ['locked.txt']
    assert str(attempts[0]).endswith(ATOMIC_WRITE_TEMP_SUFFIX)
