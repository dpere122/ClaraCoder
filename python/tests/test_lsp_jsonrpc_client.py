"""Tests for the subprocess JSON-RPC LSP client."""

from __future__ import annotations

from pathlib import Path

import pytest

from clara_coder_backend.lsp.client import JsonRpcLspClient, configuration_values_for_items, lookup_nested_section


class _BrokenStdin:
    def write(self, data: bytes) -> None:
        del data
        raise BrokenPipeError('broken pipe')

    def flush(self) -> None:
        return None

    def close(self) -> None:
        return None


class _FakeClosedProcess:
    stdin = _BrokenStdin()

    def __init__(self) -> None:
        self.killed = False

    def poll(self) -> int | None:
        return -1 if self.killed else None

    def wait(self, timeout: float | None = None) -> int:
        del timeout
        self.killed = True
        return -1

    def kill(self) -> None:
        self.killed = True


def test_start_merges_env_overrides_over_inherited_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A custom env (e.g. ELECTRON_RUN_AS_NODE=1 for bundled vtsls) must not wipe PATH/HOME."""

    captured: dict[str, object] = {}

    class _FakeProc:
        def __init__(self, command, **kwargs) -> None:
            captured['command'] = command
            captured['kwargs'] = kwargs

    monkeypatch.setenv('CLARA_TEST_INHERITED', 'inherited-value')
    monkeypatch.setattr('clara_coder_backend.lsp.client.subprocess.Popen', _FakeProc)
    monkeypatch.setattr('clara_coder_backend.lsp.client.threading.Thread', lambda **kwargs: type('T', (), {'start': lambda self: None})())

    client = JsonRpcLspClient(
        ['vtsls', '--stdio'],
        workspace_root=Path.cwd(),
        env={'ELECTRON_RUN_AS_NODE': '1'},
    )
    client.start()

    spawn_env = captured['kwargs']['env']  # type: ignore[index]
    assert spawn_env['ELECTRON_RUN_AS_NODE'] == '1'
    assert spawn_env['CLARA_TEST_INHERITED'] == 'inherited-value'


def test_start_without_env_inherits_parent_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    class _FakeProc:
        def __init__(self, command, **kwargs) -> None:
            captured['kwargs'] = kwargs

    monkeypatch.setattr('clara_coder_backend.lsp.client.subprocess.Popen', _FakeProc)
    monkeypatch.setattr('clara_coder_backend.lsp.client.threading.Thread', lambda **kwargs: type('T', (), {'start': lambda self: None})())

    client = JsonRpcLspClient(['server'], workspace_root=Path.cwd())
    client.start()

    assert 'env' not in captured['kwargs']  # type: ignore[operator]


def test_request_send_failure_clears_pending_and_reports_closed_client() -> None:
    client = JsonRpcLspClient(['unused'], workspace_root=Path.cwd())
    fake_proc = _FakeClosedProcess()
    client._proc = fake_proc

    with pytest.raises(RuntimeError, match='LSP client closed'):
        client.request('textDocument/hover', {'textDocument': {'uri': 'file:///x.py'}}, timeout_s=0.1)

    assert client._pending == {}
    assert client._proc is None
    assert fake_proc.killed is True
    assert client.is_running() is False


def test_is_running_false_when_process_exited() -> None:
    client = JsonRpcLspClient(['unused'], workspace_root=Path.cwd())

    class _Exited:
        def poll(self) -> int:
            return 1

    client._proc = _Exited()  # type: ignore[assignment]
    assert client.is_running() is False


def test_require_process_rejects_exited_subprocess() -> None:
    client = JsonRpcLspClient(['unused'], workspace_root=Path.cwd())

    class _Exited:
        stdin = None

        def poll(self) -> int:
            return 1

    client._proc = _Exited()  # type: ignore[assignment]
    with pytest.raises(RuntimeError, match='not running'):
        client._require_process()


class _PartialReadStream:
    """Simulates OS pipe reads that return fewer bytes than requested."""

    def __init__(self, data: bytes, *, max_chunk: int = 7) -> None:
        self._data = data
        self._pos = 0
        self._max_chunk = max_chunk

    def read(self, n: int = -1) -> bytes:
        if self._pos >= len(self._data):
            return b''
        if n is None or n < 0:
            n = len(self._data) - self._pos
        take = min(n, self._max_chunk, len(self._data) - self._pos)
        out = self._data[self._pos : self._pos + take]
        self._pos += take
        return out

    def readline(self) -> bytes:
        if self._pos >= len(self._data):
            return b''
        nl = self._data.find(b'\n', self._pos)
        if nl < 0:
            out = self._data[self._pos :]
            self._pos = len(self._data)
            return out
        out = self._data[self._pos : nl + 1]
        self._pos = nl + 1
        return out


def test_read_exact_assembles_partial_pipe_chunks() -> None:
    payload = b'{"jsonrpc":"2.0","method":"window/logMessage","params":{"type":3,"message":"hi"}}'
    framed = f'Content-Length: {len(payload)}\r\n\r\n'.encode('ascii') + payload
    stream = _PartialReadStream(framed, max_chunk=5)
    body = JsonRpcLspClient._read_exact(stream, len(framed))
    assert body == framed


def test_stdout_loop_handles_partial_reads_without_json_error() -> None:
    """Regression: single ``read(content-length)`` can truncate mid-string (~65KB JDT messages)."""

    import json

    large_msg = 'x' * 70_000
    payload_obj = {
        'jsonrpc': '2.0',
        'method': 'window/logMessage',
        'params': {'type': 3, 'message': large_msg},
    }
    payload = json.dumps(payload_obj, separators=(',', ':')).encode('utf-8')
    framed = f'Content-Length: {len(payload)}\r\n\r\n'.encode('ascii') + payload

    seen: list[dict] = []

    class _Proc:
        def __init__(self) -> None:
            self.stdout = _PartialReadStream(framed, max_chunk=4096)
            self.stderr = None
            self.stdin = _BrokenStdin()
            self._dead = False

        def poll(self) -> int | None:
            return 0 if self._dead else None

        def wait(self, timeout: float | None = None) -> int:
            del timeout
            self._dead = True
            return 0

        def kill(self) -> None:
            self._dead = True

    client = JsonRpcLspClient(
        ['unused'],
        workspace_root=Path.cwd(),
        notification_handler=lambda m, p: seen.append({'method': m, 'params': p}),
    )
    client._proc = _Proc()  # type: ignore[assignment]
    client._read_stdout_loop()

    assert len(seen) == 1
    assert seen[0]['method'] == 'window/logMessage'
    assert seen[0]['params']['message'] == large_msg
    # Loop ends after EOF following the one message; client should close cleanly.
    assert client.is_running() is False


def test_lookup_nested_section_walks_dotted_keys() -> None:
    opts = {
        'python': {'pythonPath': '/venv/bin/python'},
        'basedpyright': {'analysis': {'diagnosticMode': 'openFilesOnly'}},
    }
    assert lookup_nested_section(opts, '') == opts
    assert lookup_nested_section(opts, 'python') == {'pythonPath': '/venv/bin/python'}
    assert lookup_nested_section(opts, 'python.pythonPath') == '/venv/bin/python'
    assert lookup_nested_section(opts, 'basedpyright.analysis.diagnosticMode') == 'openFilesOnly'
    assert lookup_nested_section(opts, 'missing') is None
    assert lookup_nested_section(opts, 'python.missing') is None


def test_configuration_values_for_items_maps_sections() -> None:
    opts = {
        'python': {'pythonPath': '/venv/bin/python'},
        'basedpyright': {'analysis': {'typeCheckingMode': 'standard'}},
    }
    result = configuration_values_for_items(
        opts,
        {
            'items': [
                {'section': 'python'},
                {'section': 'basedpyright.analysis'},
                {'section': 'unknown'},
            ]
        },
    )
    assert result == [
        {'pythonPath': '/venv/bin/python'},
        {'typeCheckingMode': 'standard'},
        None,
    ]


def test_reply_to_workspace_configuration_uses_stored_init_options() -> None:
    client = JsonRpcLspClient(['unused'], workspace_root=Path.cwd())
    client._initialization_options = {'python': {'pythonPath': '/py'}}
    sent: list[dict] = []
    client._send_message = lambda payload: sent.append(payload)  # type: ignore[method-assign]
    client._reply_to_server_request(
        {
            'id': 7,
            'method': 'workspace/configuration',
            'params': {'items': [{'section': 'python'}, {'section': 'missing'}]},
        }
    )
    assert sent == [{'jsonrpc': '2.0', 'id': 7, 'result': [{'pythonPath': '/py'}, None]}]


def test_initialize_notifies_did_change_configuration() -> None:
    client = JsonRpcLspClient(['unused'], workspace_root=Path.cwd())
    notified: list[tuple[str, dict]] = []
    opts = {'python': {'pythonPath': '/py'}}
    client.start = lambda: None  # type: ignore[method-assign]
    client.request = lambda *a, **k: {'capabilities': {}}  # type: ignore[method-assign]
    client.notify = lambda method, params: notified.append((method, params))  # type: ignore[method-assign]

    client.initialize(
        root_uri='file:///tmp',
        process_id=1,
        capabilities={},
        initialization_options=opts,
    )

    assert client._initialization_options == opts
    assert notified[0] == ('initialized', {})
    assert notified[1] == ('workspace/didChangeConfiguration', {'settings': opts})
