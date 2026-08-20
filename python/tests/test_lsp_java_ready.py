"""Java LSP language/status readiness wait (no live JDT process)."""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from clara_coder_backend.lsp.manager import (
    SessionWorkspaceLspManager,
    java_workspace_is_ready,
    shutdown_all_lsp_managers,
)
from clara_coder_backend.session.state import current_session_id, get_session


def test_java_workspace_is_ready_statuses() -> None:
    assert java_workspace_is_ready('Started') is True
    assert java_workspace_is_ready('ServiceReady') is True
    assert java_workspace_is_ready('ProjectStatus', 'OK') is True
    assert java_workspace_is_ready('ProjectStatus', 'Ready') is True
    assert java_workspace_is_ready('Starting') is False
    assert java_workspace_is_ready('ProjectStatus', 'Error') is False
    assert java_workspace_is_ready('') is False


def _java_manager(tmp_path: Path, session_id: str) -> tuple[SessionWorkspaceLspManager, object]:
    workspace = tmp_path / 'ws'
    workspace.mkdir()
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.workspace_path = str(workspace.resolve())
    session.lsp_diagnostics_by_scope = {'workspace': {}, 'staging': {}}
    mgr = SessionWorkspaceLspManager(
        session_id=session_id,
        session=session,
        workspace_root=workspace,
        scope='workspace',
        server_kind='java',
        client_factory=lambda **kwargs: (_ for _ in ()).throw(AssertionError('should not spawn')),
    )
    return mgr, token


def test_wait_for_java_ready_treats_projectstatus_ok(tmp_path: Path) -> None:
    shutdown_all_lsp_managers()
    mgr, token = _java_manager(tmp_path, 'java-ready-projectstatus')
    try:
        mgr._handle_notification('language/status', {'type': 'ProjectStatus', 'message': 'OK'})
        started = time.monotonic()
        mgr._wait_for_java_workspace_ready(timeout_s=8.0)
        assert time.monotonic() - started < 0.5
    finally:
        current_session_id.reset(token)
        shutdown_all_lsp_managers()


def test_wait_for_java_ready_treats_started(tmp_path: Path) -> None:
    shutdown_all_lsp_managers()
    mgr, token = _java_manager(tmp_path, 'java-ready-started')
    try:
        mgr._handle_notification('language/status', {'type': 'Started', 'message': 'Ready'})
        started = time.monotonic()
        mgr._wait_for_java_workspace_ready(timeout_s=8.0)
        assert time.monotonic() - started < 0.5
    finally:
        current_session_id.reset(token)
        shutdown_all_lsp_managers()


def test_wait_for_java_ready_does_not_block_long_on_starting(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import clara_coder_backend.lsp.manager as lsp_manager

    monkeypatch.setattr(lsp_manager, '_JAVA_STARTING_GRACE_S', 0.3)
    shutdown_all_lsp_managers()
    mgr, token = _java_manager(tmp_path, 'java-ready-starting')
    try:
        mgr._handle_notification('language/status', {'type': 'Starting', 'message': 'Init'})
        started = time.monotonic()
        mgr._wait_for_java_workspace_ready(timeout_s=60.0)
        elapsed = time.monotonic() - started
        assert elapsed < 1.5
        assert elapsed >= 0.25
    finally:
        current_session_id.reset(token)
        shutdown_all_lsp_managers()
