"""Tests for the subprocess JSON-RPC LSP client."""

from __future__ import annotations

from pathlib import Path

import pytest

from clara_coder_backend.lsp.client import JsonRpcLspClient


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
