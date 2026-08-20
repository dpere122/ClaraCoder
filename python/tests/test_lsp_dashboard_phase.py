"""Dashboard lifecycle phases without spawning a live language server."""

from __future__ import annotations

from pathlib import Path

from clara_coder_backend.lsp import manager as lsp_manager
from clara_coder_backend.lsp.manager import (
    SessionWorkspaceLspManager,
    get_lsp_dashboard_status,
    shutdown_all_lsp_managers,
)
from clara_coder_backend.session.state import current_session_id, get_session


def _manager(
    tmp_path: Path,
    session_id: str,
    *,
    server_kind: str = 'python',
    scope: str = 'workspace',
) -> tuple[SessionWorkspaceLspManager, object]:
    workspace = tmp_path / 'ws'
    workspace.mkdir(exist_ok=True)
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.workspace_path = str(workspace.resolve())
    session.lsp_diagnostics_by_scope = {'workspace': {}, 'staging': {}}
    mgr = SessionWorkspaceLspManager(
        session_id=session_id,
        session=session,
        workspace_root=workspace,
        scope=scope,
        server_kind=server_kind,
        client_factory=lambda **kwargs: (_ for _ in ()).throw(AssertionError('should not spawn')),
    )
    return mgr, token


def test_dashboard_idle_phase_when_no_managers(tmp_path: Path) -> None:
    shutdown_all_lsp_managers()
    mgr, token = _manager(tmp_path, 'dash-idle')
    try:
        st = get_lsp_dashboard_status(mgr.session_id)
        for srv_id in ('python', 'typescript', 'gdscript', 'java'):
            assert st['servers'][srv_id]['initialized'] is False
            assert st['servers'][srv_id]['phase'] == 'idle'
    finally:
        current_session_id.reset(token)
        shutdown_all_lsp_managers()


def test_dashboard_reports_indexing_and_language_status(tmp_path: Path) -> None:
    shutdown_all_lsp_managers()
    mgr, token = _manager(tmp_path, 'dash-indexing', server_kind='java')
    try:
        mgr._lifecycle_phase = 'indexing'
        mgr._language_status = 'Starting'
        mgr._language_status_message = 'Init'
        lsp_manager._SESSION_MANAGERS[(mgr.session_id, 'java', 'workspace')] = mgr
        st = get_lsp_dashboard_status(mgr.session_id)
        java = st['servers']['java']
        assert java['initialized'] is False
        assert java['phase'] == 'indexing'
        assert java['languageStatus'] == 'Starting: Init'
        assert java['scope'] == 'workspace'
        assert st['servers']['python']['phase'] == 'idle'
    finally:
        current_session_id.reset(token)
        shutdown_all_lsp_managers()


def test_dashboard_prefers_shutting_down_over_running(tmp_path: Path) -> None:
    shutdown_all_lsp_managers()
    ws_mgr, token = _manager(tmp_path, 'dash-agg', scope='workspace')
    st_mgr, _token2 = _manager(tmp_path, 'dash-agg', scope='staging')
    try:
        ws_mgr._lifecycle_phase = 'running'
        st_mgr._lifecycle_phase = 'shuttingDown'
        lsp_manager._SESSION_MANAGERS[(ws_mgr.session_id, 'python', 'workspace')] = ws_mgr
        lsp_manager._SESSION_MANAGERS[(st_mgr.session_id, 'python', 'staging')] = st_mgr
        st = get_lsp_dashboard_status(ws_mgr.session_id)
        assert st['servers']['python']['phase'] == 'shuttingDown'
        assert st['servers']['python']['scope'] == 'staging'
    finally:
        current_session_id.reset(token)
        shutdown_all_lsp_managers()


def test_java_language_status_flips_indexing_to_running(tmp_path: Path) -> None:
    shutdown_all_lsp_managers()
    mgr, token = _manager(tmp_path, 'dash-java-flip', server_kind='java')
    try:
        mgr._lifecycle_phase = 'indexing'
        mgr._handle_notification('language/status', {'type': 'ServiceReady', 'message': 'Ready'})
        assert mgr.lifecycle_phase() == 'running'
    finally:
        current_session_id.reset(token)
        shutdown_all_lsp_managers()


def test_shutdown_sets_phase_before_client_close(tmp_path: Path) -> None:
    shutdown_all_lsp_managers()
    mgr, token = _manager(tmp_path, 'dash-shutdown')
    seen: list[str] = []

    class RecordingClient:
        def is_running(self) -> bool:
            return True

        def shutdown(self) -> None:
            seen.append(mgr.lifecycle_phase())
            seen.append(get_lsp_dashboard_status(mgr.session_id)['servers']['python']['phase'])

        def close(self) -> None:
            return None

    try:
        mgr._lifecycle_phase = 'running'
        mgr._client = RecordingClient()
        lsp_manager._SESSION_MANAGERS[(mgr.session_id, 'python', 'workspace')] = mgr
        mgr.shutdown()
        assert seen == ['shuttingDown', 'shuttingDown']
        assert mgr.lifecycle_phase() == 'shuttingDown'
    finally:
        current_session_id.reset(token)
        shutdown_all_lsp_managers()


def test_dashboard_treats_dead_client_as_crashed(tmp_path: Path) -> None:
    shutdown_all_lsp_managers()
    mgr, token = _manager(tmp_path, 'dash-crashed')

    class DeadClient:
        def is_running(self) -> bool:
            return False

    try:
        mgr._lifecycle_phase = 'running'
        mgr._client = DeadClient()
        lsp_manager._SESSION_MANAGERS[(mgr.session_id, 'python', 'workspace')] = mgr
        st = get_lsp_dashboard_status(mgr.session_id)
        assert st['servers']['python']['phase'] == 'crashed'
        assert st['servers']['python']['initialized'] is False
        assert st['servers']['python']['lastError']
    finally:
        current_session_id.reset(token)
        shutdown_all_lsp_managers()


def test_shutdown_all_clears_managers_from_map(tmp_path: Path) -> None:
    shutdown_all_lsp_managers()
    mgr, token = _manager(tmp_path, 'dash-shutdown-all')
    try:
        mgr._lifecycle_phase = 'running'
        lsp_manager._SESSION_MANAGERS[(mgr.session_id, 'python', 'workspace')] = mgr
        shutdown_all_lsp_managers()
        assert lsp_manager._SESSION_MANAGERS == {}
        st = get_lsp_dashboard_status(mgr.session_id)
        assert st['servers']['python']['phase'] == 'idle'
    finally:
        current_session_id.reset(token)
        shutdown_all_lsp_managers()
