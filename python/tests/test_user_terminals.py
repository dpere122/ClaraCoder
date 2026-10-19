"""Tests for user interactive PTY terminal mirroring and ``check_user_terminals`` tool."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from clara_coder_backend.hitl.tool_registry import TOOL_FAMILIES, worker_tools_and_map
from clara_coder_backend.main import app
from clara_coder_backend.session.state import current_session_id, get_session
from clara_coder_backend.tools.user_terminals import (
    CHECK_USER_TERMINALS_NAME,
    append_user_pty_output,
    check_user_terminals_tool,
    clean_terminal_output,
    clear_all_user_pty_terminals,
    mark_user_pty_exited,
    register_user_pty_terminal,
    remove_user_pty_terminal,
    update_user_pty_cwd,
    user_pty_terminals,
)


@pytest.fixture(autouse=True)
def _clean_terminals():
    clear_all_user_pty_terminals()
    yield
    clear_all_user_pty_terminals()


def test_check_user_terminals_bound_in_both_modes() -> None:
    read_tools, read_map = worker_tools_and_map(False)
    edit_tools, edit_map = worker_tools_and_map(True)

    assert CHECK_USER_TERMINALS_NAME in read_map
    assert CHECK_USER_TERMINALS_NAME in edit_map
    assert any(t.name == CHECK_USER_TERMINALS_NAME for t in read_tools)
    assert any(t.name == CHECK_USER_TERMINALS_NAME for t in edit_tools)

    process_members = dict(TOOL_FAMILIES).get('Process', ())
    assert CHECK_USER_TERMINALS_NAME in process_members


def test_clean_terminal_output_strips_ansi_and_handles_cr() -> None:
    raw = (
        '\x1b]7;file://localhost/workspace/src\x07'
        '\x1b[32mPS C:\\workspace>\x1b[0m npm test\r\n'
        'Progress 10%\rProgress 50%\rProgress 100%\r\n'
        '\x1b[31m1 failing\x1b[0m\r\n'
    )
    lines = clean_terminal_output(raw)
    assert lines == [
        'PS C:\\workspace> npm test',
        'Progress 100%',
        '1 failing',
    ]


def test_check_user_terminals_empty() -> None:
    out = check_user_terminals_tool.invoke({})
    assert out == 'No active user PTY terminals.'


def test_check_user_terminals_reports_metadata_and_tail() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = str(Path(td).resolve())
        sub = str((Path(td) / 'packages' / 'app').resolve())
        sid = 'test-user-term-session'
        token = current_session_id.set(sid)
        try:
            sess = get_session(sid)
            sess.workspace_path = root

            register_user_pty_terminal(
                session_id='pty-1111',
                workspace_root=root,
                cwd=root,
                shell='/bin/zsh',
                pid=4321,
                cols=120,
                rows=30,
            )
            append_user_pty_output(
                'pty-1111',
                '\x1b[36m$ npm run dev\x1b[0m\r\nLocal: http://127.0.0.1:4200\r\n',
                cwd=sub,
            )

            out = check_user_terminals_tool.invoke({'tail_lines': 10})
            assert 'User PTY terminals (1):' in out
            assert '`pty-1111`' in out
            assert 'status: running' in out
            assert 'cwd: `packages/app`' in out
            assert 'shell: `zsh`' in out
            assert 'pid: 4321' in out
            assert '│ $ npm run dev' in out
            assert '│ Local: http://127.0.0.1:4200' in out

            # Metadata-only mode
            meta_only = check_user_terminals_tool.invoke({'tail_lines': 0})
            assert '`pty-1111`' in meta_only
            assert 'Recent output' not in meta_only

            # Unknown terminal_id filter
            err = check_user_terminals_tool.invoke({'terminal_id': 'pty-missing'})
            assert 'Tool error: no user terminal with id `pty-missing`' in err
            assert '`pty-1111`' in err
        finally:
            current_session_id.reset(token)


def test_workspace_pty_routes_lifecycle(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('CLARA_SIDECAR_TOKEN', raising=False)
    monkeypatch.setenv('CLARA_SIDECAR_AUTH_OPTIONAL', '1')
    client = TestClient(app)

    r = client.post(
        '/workspace-pty/register',
        json={
            'sessionId': 'pty-route-1',
            'workspaceRoot': '/workspace',
            'cwd': '/workspace',
            'shell': 'powershell.exe',
            'pid': 999,
            'cols': 80,
            'rows': 24,
        },
    )
    assert r.status_code == 200
    assert r.json() == {'ok': True}
    assert 'pty-route-1' in user_pty_terminals()

    r = client.post(
        '/workspace-pty/output',
        json={
            'sessionId': 'pty-route-1',
            'data': 'hello from shell\r\n',
            'cwd': '/workspace/src',
        },
    )
    assert r.status_code == 200
    assert r.json() == {'ok': True}
    assert user_pty_terminals()['pty-route-1'].cwd == '/workspace/src'

    r = client.post(
        '/workspace-pty/cwd',
        json={'sessionId': 'pty-route-1', 'cwd': '/workspace/tests'},
    )
    assert r.status_code == 200
    assert user_pty_terminals()['pty-route-1'].cwd == '/workspace/tests'

    r = client.post(
        '/workspace-pty/exit',
        json={'sessionId': 'pty-route-1', 'exitCode': 2, 'removed': False},
    )
    assert r.status_code == 200
    assert user_pty_terminals()['pty-route-1'].status == 'exited'
    assert user_pty_terminals()['pty-route-1'].exit_code == 2

    r = client.post(
        '/workspace-pty/exit',
        json={'sessionId': 'pty-route-1', 'exitCode': None, 'removed': True},
    )
    assert r.status_code == 200
    assert 'pty-route-1' not in user_pty_terminals()


def test_update_and_remove_helpers() -> None:
    register_user_pty_terminal(session_id='pty-2', workspace_root='/ws', cwd='/ws')
    assert update_user_pty_cwd('pty-2', '/ws/sub') is True
    assert mark_user_pty_exited('pty-2', 0) is True
    assert remove_user_pty_terminal('pty-2') is True
    assert remove_user_pty_terminal('pty-2') is False
