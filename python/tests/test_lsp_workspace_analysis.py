"""Whole-workspace Python diagnostics: waiting for basedpyright's scan, and the agent's all-files call."""

from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any

import pytest

from clara_coder_backend.domain import RuntimePythonLspConfig, RuntimeToolsConfig
from clara_coder_backend.lsp.manager import get_session_lsp_manager, shutdown_all_lsp_managers
from clara_coder_backend.session.state import current_session_id, get_session, runtime_config
from clara_coder_backend.tools import lsp_tools
from clara_coder_backend.tools.lsp_tools import lsp_get_diagnostics


def _diag(message: str) -> dict[str, Any]:
    return {
        'range': {'start': {'line': 0, 'character': 0}, 'end': {'line': 0, 'character': 1}},
        'severity': 1,
        'source': 'basedpyright',
        'message': message,
    }


class _ScanningClient:
    """Acts like basedpyright in workspace mode: after ``initialize`` it publishes every file.

    ``progress`` sends ``$/progress`` begin / report / end around the scan, as basedpyright does
    when the client advertises ``window.workDoneProgress``; ``finish`` False leaves it running.
    """

    def __init__(self, *, workspace_root, notification_handler, files, progress=True, finish=True, delay_s=0.15):
        self.workspace_root = Path(workspace_root)
        self.handler = notification_handler
        self.files = files
        self.progress = progress
        self.finish = finish
        self.delay_s = delay_s
        self.capabilities: dict[str, Any] = {}
        self.closed = False

    def initialize(self, *, root_uri, process_id, capabilities, initialization_options=None):
        del root_uri, process_id, initialization_options
        self.capabilities = capabilities
        threading.Thread(target=self._scan, daemon=True).start()
        return {'capabilities': {}}

    def _scan(self) -> None:
        time.sleep(self.delay_s)
        token = 'scan-1'
        if self.progress:
            self.handler('$/progress', {'token': token, 'value': {'kind': 'begin', 'title': ''}})
            self.handler(
                '$/progress', {'token': token, 'value': {'kind': 'report', 'message': f'{len(self.files)} files to analyze'}}
            )
        if not self.finish:
            return
        for rel, messages in self.files.items():
            uri = (self.workspace_root / rel).resolve().as_uri()
            self.handler('textDocument/publishDiagnostics', {'uri': uri, 'diagnostics': [_diag(m) for m in messages]})
        if self.progress:
            self.handler('$/progress', {'token': token, 'value': {'kind': 'end'}})

    def request(self, method, params, *, timeout_s=10.0):
        del params, timeout_s
        if method == 'shutdown':
            self.closed = True
            return {}
        raise AssertionError(f'unexpected LSP request: {method}')

    def notify(self, method, params):
        del params
        if method == 'exit':
            self.closed = True

    def is_running(self) -> bool:
        return not self.closed

    def close(self) -> None:
        self.closed = True

    def shutdown(self):
        self.closed = True


@pytest.fixture(autouse=True)
def _reset_lsp_state():
    saved_tools, saved_lsp_python = runtime_config.tools, runtime_config.lsp.python
    runtime_config.tools = RuntimeToolsConfig(edit_tools_strict=False)
    shutdown_all_lsp_managers()
    yield
    shutdown_all_lsp_managers()
    runtime_config.tools = saved_tools
    runtime_config.lsp.python = saved_lsp_python


@pytest.fixture()
def workspace(tmp_path: Path):
    ws = tmp_path / 'ws'
    (ws / 'pkg').mkdir(parents=True)
    (ws / 'main.py').write_text('import pkg.never_opened\n', encoding='utf-8')
    (ws / 'pkg' / 'never_opened.py').write_text('x: int = "s"\n', encoding='utf-8')

    session_id = 'lsp-workspace-analysis'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.workspace_path = str(ws.resolve())
    session.lsp_diagnostics_by_scope = {'workspace': {}, 'staging': {}}
    session.lsp_active_scope = 'workspace'
    session.lsp_workspace_root = ''
    yield ws, session_id
    current_session_id.reset(token)


def _manager(session_id: str, clients: list[_ScanningClient], **client_kwargs):
    files = client_kwargs.pop('files', {'pkg/never_opened.py': ['Type "str" is not assignable to "int"'], 'main.py': []})

    def factory(*, command, workspace_root, notification_handler, env=None):
        del command, env
        client = _ScanningClient(
            workspace_root=workspace_root, notification_handler=notification_handler, files=files, **client_kwargs
        )
        clients.append(client)
        return client

    return get_session_lsp_manager(session_id, client_factory=factory, server='python', scope='workspace', set_active=False)


def test_python_plugin_advertises_work_done_progress(workspace) -> None:
    _, sid = workspace
    clients: list[_ScanningClient] = []
    _manager(sid, clients).ensure_started()
    assert clients[0].capabilities.get('window', {}).get('workDoneProgress') is True


def test_wait_settles_after_the_scan_and_holds_files_never_opened(workspace) -> None:
    _, sid = workspace
    manager = _manager(sid, [])
    started = time.monotonic()
    assert manager.wait_for_workspace_analysis(timeout_s=10, quiet_s=0.3) is True
    assert time.monotonic() - started < 5, 'progress end settles it without the start-up grace'
    messages = [row['message'] for row in manager.get_diagnostics('pkg/never_opened.py')]
    assert messages == ['Type "str" is not assignable to "int"']
    assert manager.lifecycle_phase() == 'running'


def test_wait_times_out_while_the_scan_runs_and_reports_progress(workspace) -> None:
    _, sid = workspace
    manager = _manager(sid, [], finish=False)
    assert manager.wait_for_workspace_analysis(timeout_s=0.8, quiet_s=0.1) is False
    assert manager.analysis_progress_report() == '2 files to analyze'
    assert manager.lifecycle_phase() == 'indexing'


def test_wait_returns_at_once_when_the_server_dies_mid_scan(workspace) -> None:
    _, sid = workspace
    clients: list[_ScanningClient] = []
    manager = _manager(sid, clients, finish=False)
    manager.ensure_started()

    def crash() -> None:
        time.sleep(0.2)
        clients[0].closed = True
        manager._handle_notification('$/progress', {'token': 'scan-1', 'value': {'kind': 'report', 'message': ''}})

    threading.Thread(target=crash, daemon=True).start()
    started = time.monotonic()
    assert manager.wait_for_workspace_analysis(timeout_s=10, quiet_s=0.1) is False
    assert time.monotonic() - started < 2, 'did not wait out the timeout on a dead server'
    assert not manager.is_client_running()


def test_wait_without_progress_settles_after_the_startup_grace(workspace) -> None:
    _, sid = workspace
    manager = _manager(sid, [], progress=False)
    started = time.monotonic()
    assert manager.wait_for_workspace_analysis(timeout_s=10, quiet_s=0.2, startup_grace_s=1.0) is True
    assert time.monotonic() - started >= 1.0
    assert manager.get_diagnostics('pkg/never_opened.py')


def test_wait_on_a_settled_server_still_gives_a_new_scan_time_to_begin(workspace) -> None:
    _, sid = workspace
    manager = _manager(sid, [])
    assert manager.wait_for_workspace_analysis(timeout_s=10, quiet_s=0.2) is True

    def rescan() -> None:
        time.sleep(0.1)
        manager._handle_notification('$/progress', {'token': 'scan-2', 'value': {'kind': 'begin', 'title': ''}})
        time.sleep(0.4)
        manager._handle_notification('$/progress', {'token': 'scan-2', 'value': {'kind': 'end'}})

    threading.Thread(target=rescan, daemon=True).start()
    started = time.monotonic()
    assert manager.wait_for_workspace_analysis(timeout_s=10, quiet_s=0.3) is True
    assert time.monotonic() - started >= 0.5, 'waited for the re-scan that began inside the quiet window'


def test_all_files_call_starts_basedpyright_and_lists_files_never_opened(workspace) -> None:
    _, sid = workspace
    runtime_config.lsp.python = RuntimePythonLspConfig(diagnostic_mode='workspace')
    clients: list[_ScanningClient] = []
    manager = _manager(sid, clients)
    assert not manager.is_client_running()

    text = lsp_get_diagnostics.invoke({})

    assert len(clients) == 1, 'the all-files call started the server itself'
    assert '`pkg/never_opened.py`' in text
    assert 'Type "str" is not assignable to "int"' in text
    assert 'basedpyright analyzed the whole workspace' in text


def test_all_files_call_says_when_the_scan_is_still_running(workspace, monkeypatch: pytest.MonkeyPatch) -> None:
    _, sid = workspace
    runtime_config.lsp.python = RuntimePythonLspConfig(diagnostic_mode='workspace')
    monkeypatch.setattr(lsp_tools, '_PYTHON_WORKSPACE_ANALYSIS_TIMEOUT_S', 0.8)
    _manager(sid, [], finish=False)

    text = lsp_get_diagnostics.invoke({})

    assert 'still analyzing the workspace (2 files to analyze)' in text
    assert 'Call again' in text


def test_all_files_call_in_open_files_mode_does_not_start_the_server(workspace) -> None:
    _, sid = workspace
    runtime_config.lsp.python = RuntimePythonLspConfig(diagnostic_mode='openFilesOnly')
    clients: list[_ScanningClient] = []
    _manager(sid, clients)

    text = lsp_get_diagnostics.invoke({})

    assert clients == []
    assert 'only files opened in this session are analyzed' in text


def test_all_files_call_ignores_python_for_a_workspace_without_it(workspace) -> None:
    ws, sid = workspace
    (ws / 'main.py').unlink()
    (ws / 'pkg' / 'never_opened.py').rename(ws / 'pkg' / 'never_opened.txt')
    runtime_config.lsp.python = RuntimePythonLspConfig(diagnostic_mode='workspace')
    clients: list[_ScanningClient] = []
    _manager(sid, clients)

    text = lsp_get_diagnostics.invoke({})

    assert clients == []
    assert text == 'No cached LSP diagnostics are available.'
