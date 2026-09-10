"""``textDocument/didChange`` must replace the exact buffer the server holds.

vtsls turns a range-less ``{text}`` change into ``Range(0, 0, newLineCount, 0)`` against
tsserver's *old* buffer, which crashes tsserver (``Debug Failure. Bad line number``) or
leaves stale trailing lines behind. Incremental-sync servers therefore get one ranged
edit spanning the previously synced document; full-sync servers keep the plain form.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from clara_coder_backend.domain import RuntimeToolsConfig
from clara_coder_backend.lsp.manager import (
    _full_replace_content_changes,
    _lsp_document_end_position,
    _server_uses_incremental_sync,
    get_session_lsp_manager,
    shutdown_all_lsp_managers,
)
from clara_coder_backend.session.state import current_session_id, get_session, runtime_config


@pytest.mark.parametrize(
    ('text', 'expected'),
    [
        ('', {'line': 0, 'character': 0}),
        ('abc', {'line': 0, 'character': 3}),
        ('a\nb', {'line': 1, 'character': 1}),
        ('a\nb\n', {'line': 2, 'character': 0}),
        ('a\r\nbc\r\n', {'line': 2, 'character': 0}),
        ('a\rb', {'line': 1, 'character': 1}),
        # \v / \f / U+2028 are *not* LSP line breaks.
        ('a\vb\fc\u2028d', {'line': 0, 'character': 7}),
        # ``character`` is in UTF-16 code units: an astral emoji counts as 2.
        ('x\n\U0001f600!', {'line': 1, 'character': 3}),
    ],
)
def test_lsp_document_end_position(text: str, expected: dict[str, int]) -> None:
    assert _lsp_document_end_position(text) == expected


@pytest.mark.parametrize(
    ('capabilities', 'expected'),
    [
        ({}, False),
        ({'textDocumentSync': 1}, False),
        ({'textDocumentSync': 2}, True),
        ({'textDocumentSync': {'openClose': True, 'change': 1}}, False),
        ({'textDocumentSync': {'openClose': True, 'change': 2}}, True),
        ({'textDocumentSync': {'openClose': True}}, False),
    ],
)
def test_server_uses_incremental_sync(capabilities: dict, expected: bool) -> None:
    assert _server_uses_incremental_sync(capabilities) is expected


def test_full_replace_content_changes_shapes() -> None:
    end = {'line': 3, 'character': 7}
    assert _full_replace_content_changes('new', previous_end=end, incremental=False) == [{'text': 'new'}]
    assert _full_replace_content_changes('new', previous_end=None, incremental=True) == [{'text': 'new'}]
    ranged = _full_replace_content_changes('new', previous_end=end, incremental=True)
    assert ranged == [
        {'range': {'start': {'line': 0, 'character': 0}, 'end': {'line': 3, 'character': 7}}, 'text': 'new'}
    ]
    # The stored end position must not be aliased into the outgoing payload.
    ranged[0]['range']['end']['line'] = 99
    assert end['line'] == 3


class _RecordingLspClient:
    """Fake JSON-RPC client that records notifications and echoes empty diagnostics."""

    def __init__(self, *, sync_kind, notification_handler):
        self.sync_kind = sync_kind
        self.notification_handler = notification_handler
        self.notifications: list[tuple[str, dict]] = []
        self.closed = False

    def initialize(self, *, root_uri, process_id, capabilities, initialization_options=None):
        del root_uri, process_id, capabilities, initialization_options
        return {'capabilities': {'textDocumentSync': {'openClose': True, 'change': self.sync_kind}}}

    def request(self, method, params, *, timeout_s=10.0):
        del params, timeout_s
        if method == 'shutdown':
            self.closed = True
            return {}
        raise AssertionError(f'unexpected LSP method: {method}')

    def notify(self, method, params):
        self.notifications.append((method, params))
        if method in ('textDocument/didOpen', 'textDocument/didChange'):
            uri = params['textDocument']['uri']
            self.notification_handler('textDocument/publishDiagnostics', {'uri': uri, 'diagnostics': []})
        elif method == 'exit':
            self.closed = True

    def is_running(self) -> bool:
        return not self.closed

    def close(self) -> None:
        self.closed = True

    def shutdown(self) -> None:
        self.closed = True


@pytest.fixture(autouse=True)
def _reset_lsp_state():
    saved_tools = runtime_config.tools
    runtime_config.tools = RuntimeToolsConfig(edit_tools_strict=False)
    shutdown_all_lsp_managers()
    yield
    shutdown_all_lsp_managers()
    runtime_config.tools = saved_tools


def _make_manager(tmp_path: Path, *, sync_kind: int, session_id: str):
    workspace = tmp_path / 'ws'
    (workspace / 'pkg').mkdir(parents=True)
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.workspace_path = str(workspace.resolve())
    session.lsp_diagnostics_by_scope = {'workspace': {}, 'staging': {}}
    session.lsp_active_scope = 'workspace'
    session.lsp_workspace_root = ''
    clients: list[_RecordingLspClient] = []

    def factory(*, command, workspace_root, notification_handler, env=None):
        del command, workspace_root, env
        client = _RecordingLspClient(sync_kind=sync_kind, notification_handler=notification_handler)
        clients.append(client)
        return client

    manager = get_session_lsp_manager(session_id, client_factory=factory)
    return manager, clients, token


def _did_changes(client: _RecordingLspClient) -> list[dict]:
    return [params for method, params in client.notifications if method == 'textDocument/didChange']


def test_incremental_server_gets_ranged_full_replacement(tmp_path: Path) -> None:
    manager, clients, token = _make_manager(tmp_path, sync_kind=2, session_id='lsp-didchange-incremental')
    try:
        first = 'a = 1\nb = 2\nc = 3\n'
        manager.sync_document('pkg/mod.py', first, wait_for_diagnostics=False)
        assert len(clients) == 1
        client = clients[0]
        assert [m for m, _ in client.notifications if m.startswith('textDocument/did')] == ['textDocument/didOpen']

        # Grows by one line: this is exactly the shape that crashed tsserver.
        second = 'a = 1\nb = 2\nc = 3\nd = 4\n'
        manager.sync_document('pkg/mod.py', second, wait_for_diagnostics=False)
        changes = _did_changes(client)
        assert len(changes) == 1
        assert changes[0]['textDocument']['version'] == 2
        assert changes[0]['contentChanges'] == [
            {
                'range': {'start': {'line': 0, 'character': 0}, 'end': _lsp_document_end_position(first)},
                'text': second,
            }
        ]
        assert changes[0]['contentChanges'][0]['range']['end'] == {'line': 3, 'character': 0}

        # Shrinks: range must now span the *second* text, not the first.
        third = 'a = 1'
        manager.sync_document('pkg/mod.py', third, wait_for_diagnostics=False)
        changes = _did_changes(client)
        assert len(changes) == 2
        assert changes[1]['contentChanges'][0]['range']['end'] == {'line': 4, 'character': 0}
        assert changes[1]['contentChanges'][0]['text'] == third
    finally:
        current_session_id.reset(token)


def test_full_sync_server_keeps_range_less_change(tmp_path: Path) -> None:
    manager, clients, token = _make_manager(tmp_path, sync_kind=1, session_id='lsp-didchange-full')
    try:
        manager.sync_document('pkg/mod.py', 'a = 1\n', wait_for_diagnostics=False)
        manager.sync_document('pkg/mod.py', 'a = 1\nb = 2\n', wait_for_diagnostics=False)
        changes = _did_changes(clients[0])
        assert len(changes) == 1
        assert changes[0]['contentChanges'] == [{'text': 'a = 1\nb = 2\n'}]
    finally:
        current_session_id.reset(token)


def test_close_forgets_previous_end_so_reopen_starts_fresh(tmp_path: Path) -> None:
    manager, clients, token = _make_manager(tmp_path, sync_kind=2, session_id='lsp-didchange-close')
    try:
        manager.sync_document('pkg/mod.py', 'a = 1\nb = 2\n', wait_for_diagnostics=False)
        manager.close_document('pkg/mod.py')
        assert 'pkg/mod.py' not in manager._last_synced_end
        # Reopen is a didOpen (version 1) again, not a didChange against a stale range.
        manager.sync_document('pkg/mod.py', 'x = 0', wait_for_diagnostics=False)
        opens = [p for m, p in clients[0].notifications if m == 'textDocument/didOpen']
        assert len(opens) == 2
        assert opens[1]['textDocument']['version'] == 1
        assert _did_changes(clients[0]) == []
    finally:
        current_session_id.reset(token)
