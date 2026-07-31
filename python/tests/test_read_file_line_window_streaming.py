"""Streaming line window reads: parity with ``read_file_for_tools`` + ``read_workspace_file`` headers."""

from __future__ import annotations

from pathlib import Path

import pytest

from clara_coder_backend.session.domain import RuntimeToolsConfig
from clara_coder_backend.session.state import current_session_id, get_session, runtime_config
from clara_coder_backend.workspace.workspace_text_io import read_file_for_tools, read_file_line_window_for_tools
from clara_coder_backend.tools.workspace import read_workspace_file


@pytest.fixture(autouse=True)
def _restore_runtime_tools():
    saved = runtime_config.tools
    yield
    runtime_config.tools = saved


def _write(p: Path, raw: bytes) -> None:
    p.write_bytes(raw)


def test_streaming_matches_splitlines_utf8_variants(tmp_path: Path) -> None:
    enc = 'utf-8'
    cases: list[bytes] = [
        b'',
        b'a',
        b'a\n',
        b'a\nb',
        b'a\nb\n',
        b'\n',
        b'\n\n',
        b'a\r',
        b'a\r\n',
        b'a\r\nb',
        b'\r',
        b'\r\n',
        b'x\r\r\ny',
        b'mixed\r\nunix\nmac\rz',
        'café\nnaïve'.encode(enc),
    ]
    for raw in cases:
        p = tmp_path / 'sample.txt'
        _write(p, raw)
        expected = read_file_for_tools(p, enc).splitlines()
        win = read_file_line_window_for_tools(p, enc, 1, 10**9)
        assert win.n_lines == len(expected)
        assert win.excerpt_lines == expected


def test_streaming_matches_splitlines_utf8_sig_bom(tmp_path: Path) -> None:
    p = tmp_path / 'bom.txt'
    _write(p, bytes([0xEF, 0xBB, 0xBF]) + b'hello\nworld')
    enc = 'utf-8-sig'
    expected = read_file_for_tools(p, enc).splitlines()
    win = read_file_line_window_for_tools(p, enc, 1, 50)
    assert win.excerpt_lines == expected == ['hello', 'world']


def test_streaming_matches_splitlines_utf16(tmp_path: Path) -> None:
    text = 'alpha\nbeta\n'
    p = tmp_path / 'u16.txt'
    p.write_bytes(text.encode('utf-16'))
    enc = 'utf-16'
    expected = read_file_for_tools(p, enc).splitlines()
    win = read_file_line_window_for_tools(p, enc, 1, 50)
    assert win.excerpt_lines == expected


def test_streaming_window_slice_matches(tmp_path: Path) -> None:
    p = tmp_path / 'slice.txt'
    body = '\n'.join(f'L{i}' for i in range(1, 51))  # L1 .. L50, no trailing newline on last? use join
    p.write_text(body, encoding='utf-8')
    enc = 'utf-8'
    for lo, hi in [(1, 5), (10, 12), (48, 60)]:
        exp = read_file_for_tools(p, enc).splitlines()[lo - 1 : hi]
        win = read_file_line_window_for_tools(p, enc, lo, hi)
        assert win.excerpt_lines == exp


def test_read_workspace_file_header_total_and_tail_hint(tmp_path: Path) -> None:
    # ``_effective_max_file_read_lines`` clamps to at least 50, so use >50 lines to see tail + cap hints.
    runtime_config.tools = RuntimeToolsConfig(edit_tools_strict=False, max_file_read_lines=50)
    session_id = 'read-ws-hdr'
    token = current_session_id.set(session_id)
    try:
        root = tmp_path / 'ws'
        root.mkdir()
        session = get_session(session_id)
        session.workspace_path = str(root.resolve())
        lines = [f'line{i}' for i in range(1, 81)]
        (root / 'big.txt').write_text('\n'.join(lines), encoding='utf-8')
        out = read_workspace_file.invoke({'relative_path': 'big.txt', 'start_line': 1, 'end_line': 220})
        assert '(of 80 in file)' in out
        assert 'omitted below' in out
        assert 'max lines per tool call' in out
        assert 'line1' in out
        assert 'line50' in out
        assert 'line51' not in out
    finally:
        current_session_id.reset(token)


def test_read_workspace_file_short_file_header_not_overstated(tmp_path: Path) -> None:
    runtime_config.tools = RuntimeToolsConfig(edit_tools_strict=False, max_file_read_lines=400)
    session_id = 'read-ws-short'
    token = current_session_id.set(session_id)
    try:
        root = tmp_path / 'ws2'
        root.mkdir()
        session = get_session(session_id)
        session.workspace_path = str(root.resolve())
        (root / 'small.txt').write_text('a\nb\nc\n', encoding='utf-8')
        out = read_workspace_file.invoke({'relative_path': 'small.txt', 'start_line': 1, 'end_line': 500})
        assert 'Lines: 1-3 (of 3 in file)' in out
        assert 'omitted below' not in out
    finally:
        current_session_id.reset(token)


def test_read_workspace_file_middle_window_hints(tmp_path: Path) -> None:
    runtime_config.tools = RuntimeToolsConfig(edit_tools_strict=False, max_file_read_lines=400)
    session_id = 'read-ws-mid'
    token = current_session_id.set(session_id)
    try:
        root = tmp_path / 'ws3'
        root.mkdir()
        session = get_session(session_id)
        session.workspace_path = str(root.resolve())
        (root / 'mid.txt').write_text('x\ny\nz\n', encoding='utf-8')
        out = read_workspace_file.invoke({'relative_path': 'mid.txt', 'start_line': 2, 'end_line': 2})
        assert 'Lines: 2-2 (of 3 in file)' in out
        assert 'omitted above' in out
        assert 'omitted below' in out
        assert ' y' in out or 'y' in out
    finally:
        current_session_id.reset(token)


def test_read_workspace_plain_text_does_not_use_read_bytes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Regression: plain-text reads stream via ``open('rb')``, not ``Path.read_bytes()``."""

    runtime_config.tools = RuntimeToolsConfig(edit_tools_strict=False, max_file_read_lines=50)
    session_id = 'read-ws-norb'
    token = current_session_id.set(session_id)
    try:
        root = tmp_path / 'ws4'
        root.mkdir()
        session = get_session(session_id)
        session.workspace_path = str(root.resolve())
        target = root / 'streamed.txt'
        target.write_text('\n'.join(f'L{i}' for i in range(30)), encoding='utf-8')

        orig_rb = Path.read_bytes

        def guarded_read_bytes(self: Path, *a: object, **kw: object) -> bytes:
            if self.resolve() == target.resolve():
                raise AssertionError('read_bytes should not be used for plain-text read_workspace_file')
            return orig_rb(self, *a, **kw)

        monkeypatch.setattr(Path, 'read_bytes', guarded_read_bytes)
        out = read_workspace_file.invoke({'relative_path': 'streamed.txt', 'start_line': 1, 'end_line': 10})
        assert 'L1' in out
        assert '(of 30 in file)' in out
    finally:
        current_session_id.reset(token)
