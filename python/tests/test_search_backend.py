"""Tests for grep/rg-backed search helpers."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest

from clara_coder_backend.workspace import search_backend
from clara_coder_backend.workspace.search_backend import (
    SearchCandidate,
    run_grep_line_search,
    run_grep_workspace_recursive,
)


class _FakeStdout:
    def __init__(self, data: bytes) -> None:
        self._data = data
        self._pos = 0

    def read(self, n: int = -1) -> bytes:
        if self._pos >= len(self._data):
            return b''
        if n is None or n < 0:
            chunk = self._data[self._pos :]
            self._pos = len(self._data)
            return chunk
        chunk = self._data[self._pos : self._pos + n]
        self._pos += len(chunk)
        return chunk

    def close(self) -> None:
        return None


class _FakeProc:
    def __init__(self, stdout: bytes, *, returncode: int = 0, stderr: bytes = b'') -> None:
        self.stdout = _FakeStdout(stdout)
        self.stderr = _FakeStdout(stderr)
        self.returncode = returncode
        self.killed = False
        self._waited = False

    def poll(self) -> int | None:
        if self.killed or self._waited:
            return self.returncode
        return None

    def wait(self, timeout: float | None = None) -> int:
        self._waited = True
        return self.returncode

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9


#: A real rg for the opt-in integration test below; every other test sees only the tools it mocks.
_REAL_RG_PATH = os.environ.get('CLARA_RG_PATH', '')


@pytest.fixture(autouse=True)
def _no_bundled_rg(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('CLARA_RG_PATH', raising=False)


def _nul_record(path: str, line: int, text: str = 'hit') -> bytes:
    return path.encode('utf-8') + b'\0' + f'{line}:{text}\n'.encode('utf-8')


def test_run_grep_line_search_timeout_returns_none(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(search_backend.shutil, 'which', lambda name: '/fake/rg' if name == 'rg' else None)

    calls = {'n': 0}

    def _mono() -> float:
        calls['n'] += 1
        return 0.0 if calls['n'] == 1 else 10_000.0

    monkeypatch.setattr(search_backend.time, 'monotonic', _mono)

    class _SlowStdout:
        def read(self, n: int = -1) -> bytes:
            return b'x'

        def close(self) -> None:
            return None

    class _Proc:
        def __init__(self) -> None:
            self.stdout = _SlowStdout()
            self.stderr = _SlowStdout()
            self.returncode = 0

        def poll(self) -> None:
            return None

        def kill(self) -> None:
            return None

        def wait(self, timeout: float | None = None) -> int:
            return 0

    monkeypatch.setattr(search_backend.subprocess, 'Popen', lambda *_a, **_k: _Proc())

    out = run_grep_line_search(
        'x',
        [SearchCandidate(command_path='a.py', display_path='a.py')],
        max_matches=10,
        cwd=Path('.'),
    )
    assert out is None


def test_run_grep_line_search_success(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(search_backend.shutil, 'which', lambda name: '/fake/grep' if name == 'grep' else None)
    f = tmp_path / 'a.py'
    f.write_text('hello\n', encoding='utf-8')
    stdout = _nul_record(f.as_posix(), 1, 'hello')
    monkeypatch.setattr(
        search_backend.subprocess,
        'Popen',
        lambda *_a, **_k: _FakeProc(stdout),
    )

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


def test_run_grep_line_search_stops_at_max_matches(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(search_backend.shutil, 'which', lambda name: '/fake/grep' if name == 'grep' else None)
    stdout = b''.join(_nul_record(f'f{i}.py', 1) for i in range(20))
    proc = _FakeProc(stdout)
    monkeypatch.setattr(search_backend.subprocess, 'Popen', lambda *_a, **_k: proc)

    out = run_grep_line_search(
        'hit',
        [SearchCandidate(command_path=f'f{i}.py', display_path=f'f{i}.py') for i in range(20)],
        max_matches=3,
    )
    assert out is not None
    assert len(out) == 3
    assert proc.killed is True


def test_run_grep_workspace_recursive_respects_byte_budget(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(search_backend.shutil, 'which', lambda name: '/fake/grep' if name == 'grep' else None)
    monkeypatch.setattr(search_backend, '_MAX_SEARCH_STDOUT_BYTES', 64)
    # Oversized stdout with no complete match records past the budget — still must not grow unbounded.
    stdout = b'x' * 10_000
    proc = _FakeProc(stdout)
    monkeypatch.setattr(search_backend.subprocess, 'Popen', lambda *_a, **_k: proc)

    out = run_grep_workspace_recursive(tmp_path, 'nevermind', max_matches=50)
    assert out is not None
    assert out == []
    assert proc.killed is True


def test_run_grep_workspace_recursive_excludes_node_modules_by_default(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(search_backend.shutil, 'which', lambda name: '/fake/grep' if name == 'grep' else None)
    captured: dict[str, list[str]] = {}

    def _popen(args, **_k):
        captured['args'] = list(args)
        return _FakeProc(b'')

    monkeypatch.setattr(search_backend.subprocess, 'Popen', _popen)
    out = run_grep_workspace_recursive(
        tmp_path,
        'needle',
        max_matches=5,
        exclude_dir_names=frozenset({'dist', 'node_modules'}),
        include_node_modules=False,
    )
    assert out == []
    assert any(a == '--exclude-dir=node_modules' for a in captured['args'])


def test_run_grep_workspace_recursive_can_include_node_modules(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(search_backend.shutil, 'which', lambda name: '/fake/grep' if name == 'grep' else None)
    captured: dict[str, list[str]] = {}

    def _popen(args, **_k):
        captured['args'] = list(args)
        return _FakeProc(b'')

    monkeypatch.setattr(search_backend.subprocess, 'Popen', _popen)
    out = run_grep_workspace_recursive(
        tmp_path,
        'needle',
        max_matches=5,
        exclude_dir_names=frozenset({'dist', 'node_modules'}),
        include_node_modules=True,
    )
    assert out == []
    assert not any(a == '--exclude-dir=node_modules' for a in captured['args'])
    assert any(a == '--exclude-dir=dist' for a in captured['args'])


@pytest.mark.skipif(shutil.which('grep') is None and shutil.which('rg') is None, reason='no grep/rg')
def test_run_grep_workspace_recursive_real_excludes_node_modules(tmp_path: Path) -> None:
    src = tmp_path / 'src'
    nm = tmp_path / 'node_modules' / 'pkg'
    src.mkdir()
    nm.mkdir(parents=True)
    (src / 'a.py').write_text('UNIQUE_CLARA_NEEDLE = 1\n', encoding='utf-8')
    (nm / 'b.py').write_text('UNIQUE_CLARA_NEEDLE = 2\n', encoding='utf-8')

    out = run_grep_workspace_recursive(
        tmp_path,
        'UNIQUE_CLARA_NEEDLE',
        max_matches=10,
        include_node_modules=False,
    )
    assert out is not None
    paths = {m.display_path for m in out}
    assert 'src/a.py' in paths
    assert not any(p.startswith('node_modules/') for p in paths)


def test_rg_executable_prefers_bundled_clara_rg_path(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    bundled = tmp_path / 'rg.exe'
    bundled.write_bytes(b'')
    monkeypatch.setattr(search_backend.shutil, 'which', lambda name: '/usr/bin/rg' if name == 'rg' else None)

    monkeypatch.setenv('CLARA_RG_PATH', str(bundled))
    assert search_backend._rg_executable() == str(bundled)

    monkeypatch.setenv('CLARA_RG_PATH', str(tmp_path / 'missing.exe'))
    assert search_backend._rg_executable() == '/usr/bin/rg'


@pytest.mark.parametrize(
    ('respect_gitignore', 'present', 'absent'),
    [
        (True, ['--no-require-git', '--no-ignore-parent'], ['--no-ignore']),
        (False, ['--no-ignore'], ['--no-require-git']),
    ],
)
def test_rg_recursive_args_gitignore_flags(respect_gitignore: bool, present: list[str], absent: list[str]) -> None:
    args = search_backend._rg_recursive_args('rg', 'needle', set(), respect_gitignore=respect_gitignore)
    assert all(flag in args for flag in present)
    assert not any(flag in args for flag in absent)


@pytest.mark.skipif(not _REAL_RG_PATH, reason='set CLARA_RG_PATH to run against a real rg')
def test_real_rg_honors_gitignore_outside_a_git_repo(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv('CLARA_RG_PATH', _REAL_RG_PATH)
    (tmp_path / '.gitignore').write_text('generated/\n', encoding='utf-8')
    (tmp_path / 'generated').mkdir()
    (tmp_path / 'generated' / 'g.txt').write_text('needle\n', encoding='utf-8')
    (tmp_path / 'a.txt').write_text('needle\n', encoding='utf-8')

    kept = run_grep_workspace_recursive(tmp_path, 'needle', max_matches=10)
    assert kept is not None and [m.display_path for m in kept] == ['a.txt']
    everything = run_grep_workspace_recursive(tmp_path, 'needle', max_matches=10, respect_gitignore=False)
    assert everything is not None and sorted(m.display_path for m in everything) == ['a.txt', 'generated/g.txt']
