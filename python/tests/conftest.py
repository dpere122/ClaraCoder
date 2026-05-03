"""Shared pytest fixtures for nemo_backend tests."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest

from nemo_backend.domain import RuntimeToolsConfig
from nemo_backend.state import current_session_id, get_session, runtime_config


@pytest.fixture()
def staging_env():
    saved_staging = os.environ.get('NEMO_STAGING_DIR')
    saved_tools = runtime_config.tools

    td = tempfile.TemporaryDirectory()
    td_path = Path(td.name)
    staging_root = td_path / 'staging'
    staging_root.mkdir(parents=True)
    os.environ['NEMO_STAGING_DIR'] = str(staging_root)

    workspace = td_path / 'ws'
    workspace.mkdir()

    session_id = 'test-staging-session'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.workspace_path = str(workspace.resolve())
    session.pending_edit_stagings.clear()
    session.pending_diff_payload = None
    session.auto_apply_mode = False
    session.worker_apply_mode = True
    session.abort_event.clear()
    session.planning_nested_events_q = None
    session.lsp_staging_overlay_root = ''
    session.lsp_staging_overlay_parent = ''

    runtime_config.tools = RuntimeToolsConfig(
        edit_tools_strict=False,
        max_file_read_lines=400,
        max_search_results=40,
    )

    class _Env:
        pass

    env = _Env()
    env.staging_root = staging_root  # type: ignore[attr-defined]
    env.workspace = workspace  # type: ignore[attr-defined]
    env.session = session  # type: ignore[attr-defined]

    yield env

    current_session_id.reset(token)
    if saved_staging is None:
        os.environ.pop('NEMO_STAGING_DIR', None)
    else:
        os.environ['NEMO_STAGING_DIR'] = saved_staging
    runtime_config.tools = saved_tools
    td.cleanup()
