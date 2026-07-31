"""Tests for grep-backed search helpers."""

from __future__ import annotations

import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from clara_coder_backend.workspace.search_backend import SearchCandidate, run_grep_line_search


def test_run_grep_line_search_timeout_returns_none(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr('shutil.which', lambda _: '/fake/grep')

    def _boom(*_a, **_k):
        raise subprocess.TimeoutExpired(cmd='grep', timeout=1)

    monkeypatch.setattr('subprocess.run', _boom)

    out = run_grep_line_search(
        'x',
        [SearchCandidate(command_path='a.py', display_path='a.py')],
        max_matches=10,
        cwd=Path('.'),
    )
    assert out is None


def test_run_grep_line_search_success(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr('shutil.which', lambda _: '/fake/grep')
    f = tmp_path / 'a.py'
    f.write_text('hello\n', encoding='utf-8')

    class _Proc:
        returncode = 0
        stderr = b''
        stdout = f.as_posix().encode('utf-8', errors='surrogateescape') + b'\0' + b'1:hello\n'

    monkeypatch.setattr('subprocess.run', lambda *_a, **_k: _Proc())

    out = run_grep_line_search(
        'hello',
        [SearchCandidate(command_path=f.as_posix(), display_path='a.py')],
        max_matches=10,
        cwd=tmp_path,
    )
    assert out is not None
    assert len(out) == 1
    assert out[0].display_path == 'a.py'
    assert out[0].line_number == 1
