"""LSP staging overlay: baseline selection and effective workspace root."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from nemo_backend import staging_test_overlay as sto
from nemo_backend.edit_staging import copy_workspace_mirror
from nemo_backend.lsp.manager import SessionWorkspaceLspManager, get_session_lsp_manager
from nemo_backend.state import current_session_id


def test_copy_workspace_mirror_separate_rules_anchor(tmp_path: Path) -> None:
    """Ignore rules come from ``rules_workspace`` while files are copied from ``content_root``."""

    rules_ws = tmp_path / 'rules_ws'
    rules_ws.mkdir()
    content = tmp_path / 'content'
    content.mkdir()
    dest = tmp_path / 'dest'
    (rules_ws / '.gitignore').write_text('ignored.txt\n', encoding='utf-8')
    (content / 'keep.txt').write_text('a', encoding='utf-8')
    (content / 'ignored.txt').write_text('b', encoding='utf-8')
    copy_workspace_mirror(content, dest, rules_workspace=rules_ws)
    assert (dest / 'keep.txt').read_text(encoding='utf-8') == 'a'
    assert not (dest / 'ignored.txt').exists()


def test_build_staging_workspace_overlay_prefers_planner_snapshot(staging_env) -> None:
    ws = staging_env.workspace
    session = staging_env.session
    (ws / 'marker.txt').write_text('FROM_LIVE_WS\n', encoding='utf-8')
    snap = staging_env.staging_root.parent / 'planner_snap'
    snap.mkdir(parents=True)
    (snap / 'marker.txt').write_text('FROM_SNAPSHOT\n', encoding='utf-8')
    session.active_staging_snapshot_root = str(snap.resolve())

    overlay_root, overlay_parent, err = sto.build_staging_workspace_overlay(
        session,
        ws,
        'snap-overlay-sid',
        overlay_subdir='unit-test-overlay',
    )
    assert err == '' and overlay_root is not None and overlay_parent is not None
    try:
        assert (overlay_root / 'marker.txt').read_text(encoding='utf-8') == 'FROM_SNAPSHOT\n'
    finally:
        sto.remove_overlay_parent(overlay_parent)


def test_get_session_lsp_manager_staging_uses_ensure_overlay_root(staging_env, monkeypatch: pytest.MonkeyPatch) -> None:
    ws = staging_env.workspace
    session = staging_env.session
    (ws / 'x.py').write_text('x=1\n', encoding='utf-8')
    fake_root = ws.parent / 'fake_lsp_overlay' / 'workspace'
    fake_root.mkdir(parents=True)

    monkeypatch.setattr(
        sto,
        'ensure_lsp_staging_overlay',
        lambda session_arg, workspace_root, session_id=None: fake_root.resolve(),
    )

    session_id = 'test-staging-session'
    token = current_session_id.set(session_id)
    try:
        session.lsp_active_scope = 'staging'
        mgr = get_session_lsp_manager(session_id, scope='staging', server='python')
        assert mgr.workspace_root.resolve() == fake_root.resolve()
        assert mgr.scope == 'staging'
    finally:
        current_session_id.reset(token)


def test_clear_lsp_staging_overlay_removes_disk_and_clears_fields(staging_env) -> None:
    session = staging_env.session
    ws = staging_env.workspace
    (ws / 'p.py').write_text('a=1\n', encoding='utf-8')
    root, parent, err = sto.build_staging_workspace_overlay(
        session,
        ws,
        'clear-test-sid',
        overlay_subdir='clear-unit',
    )
    assert err == '' and root is not None and parent is not None
    session.lsp_staging_overlay_root = str(root.resolve())
    session.lsp_staging_overlay_parent = str(parent.resolve())
    assert root.is_dir()
    sto.clear_lsp_staging_overlay(session)
    assert session.lsp_staging_overlay_root == ''
    assert session.lsp_staging_overlay_parent == ''
    assert not parent.exists()


def test_session_workspace_lsp_manager_accepts_overlay_as_root(staging_env) -> None:
    """Smoke: manager can be constructed with overlay-shaped path (no subprocess start)."""

    ws = staging_env.workspace
    overlay = ws.parent / 'ovl_ws'
    overlay.mkdir()
    (overlay / 'z.py').write_text('z=1\n', encoding='utf-8')
    session = staging_env.session
    mgr = SessionWorkspaceLspManager(
        session_id='smoke-sid',
        session=session,
        workspace_root=overlay,
        scope='staging',
        server_kind='python',
        client_factory=lambda **kwargs: MagicMock(),
    )
    assert mgr.workspace_root.resolve() == overlay.resolve()
