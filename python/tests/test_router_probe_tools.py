"""Tests for nested-router read-only workspace path probes."""

from __future__ import annotations

from nemo_backend.agents.orchestration.router_probe_tools import workspace_path_status
from nemo_backend.state import current_session_id, get_session


def test_workspace_path_status_reports_file_and_dir(tmp_path) -> None:
    session_id = 'router-probe-1'
    token = current_session_id.set(session_id)
    try:
        root = tmp_path / 'ws'
        root.mkdir()
        session = get_session(session_id)
        session.workspace_path = str(root.resolve())
        (root / 'a.txt').write_text('x', encoding='utf-8')
        (root / 'subdir').mkdir()
        out = workspace_path_status.invoke({'relative_paths': 'a.txt, subdir\nmissing.py'})
        assert 'a.txt: exists=True is_file=True is_dir=False' in out
        assert 'subdir: exists=True is_file=False is_dir=True' in out
        assert 'missing.py: exists=False is_file=False is_dir=False' in out
    finally:
        current_session_id.reset(token)


def test_workspace_path_status_empty_paths(tmp_path) -> None:
    session_id = 'router-probe-2'
    token = current_session_id.set(session_id)
    try:
        root = tmp_path / 'ws'
        root.mkdir()
        session = get_session(session_id)
        session.workspace_path = str(root.resolve())
        assert workspace_path_status.invoke({'relative_paths': '   \n'}) == 'No paths provided.'
    finally:
        current_session_id.reset(token)


def test_workspace_path_status_rejects_escape(tmp_path) -> None:
    session_id = 'router-probe-3'
    token = current_session_id.set(session_id)
    try:
        root = tmp_path / 'ws'
        root.mkdir()
        session = get_session(session_id)
        session.workspace_path = str(root.resolve())
        out = workspace_path_status.invoke({'relative_paths': '../outside'})
        assert 'error:' in out
        assert 'outside' in out
    finally:
        current_session_id.reset(token)
