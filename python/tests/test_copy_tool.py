"""Unit tests for the outer-agent workspace copy tool."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from nemo_backend.copy_tool import copy_confirm_sse_payload, copy_workspace_files, execute_pending_copy_decision
from nemo_backend.state import current_session_id, get_session


@pytest.fixture()
def copy_env():
    td = tempfile.TemporaryDirectory()
    workspace = Path(td.name) / 'ws'
    workspace.mkdir()

    session_id = 'test-copy-session'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.workspace_path = str(workspace.resolve())
    session.worker_apply_mode = True
    session.auto_apply_mode = False
    session.pending_copy_request = None

    class _Env:
        pass

    env = _Env()
    env.workspace = workspace  # type: ignore[attr-defined]
    env.session = session  # type: ignore[attr-defined]

    yield env

    current_session_id.reset(token)
    td.cleanup()


def test_copy_workspace_files_auto_apply_creates_subdirectories(copy_env) -> None:
    ws = copy_env.workspace
    session = copy_env.session
    session.auto_apply_mode = True
    (ws / 'src').mkdir()
    (ws / 'src' / 'one.txt').write_text('one', encoding='utf-8')
    (ws / 'src' / 'two.txt').write_text('two', encoding='utf-8')

    out = copy_workspace_files.invoke(
        {
            'copies': [
                {'source_path': 'src/one.txt', 'destination_path': 'dist/nested/one.txt'},
                {'source_path': 'src/two.txt', 'destination_path': 'dist/two-copy.txt'},
            ]
        }
    )

    assert 'Copied 2 file(s)' in out
    assert (ws / 'dist' / 'nested' / 'one.txt').read_text(encoding='utf-8') == 'one'
    assert (ws / 'dist' / 'two-copy.txt').read_text(encoding='utf-8') == 'two'


def test_copy_workspace_files_requires_confirmation_when_auto_apply_off(copy_env) -> None:
    ws = copy_env.workspace
    session = copy_env.session
    (ws / 'src.txt').write_text('copy me', encoding='utf-8')

    out = copy_workspace_files.invoke(
        {'copies': [{'source_path': 'src.txt', 'destination_path': 'copies/subdir/dst.txt'}]}
    )

    assert 'Pending user confirmation' in out
    pending = session.pending_copy_request
    assert pending is not None
    payload = copy_confirm_sse_payload(pending)
    assert payload == {
        'version': 1,
        'requestId': pending['request_id'],
        'copies': [{'sourcePath': 'src.txt', 'destinationPath': 'copies/subdir/dst.txt'}],
        'overwrite': False,
    }
    assert not (ws / 'copies' / 'subdir' / 'dst.txt').exists()


def test_execute_pending_copy_decision_confirm_copies_files(copy_env) -> None:
    ws = copy_env.workspace
    session = copy_env.session
    (ws / 'a.txt').write_text('a', encoding='utf-8')
    (ws / 'b.txt').write_text('b', encoding='utf-8')

    copy_workspace_files.invoke(
        {
            'copies': [
                {'source_path': 'a.txt', 'destination_path': 'copied/a.txt'},
                {'source_path': 'b.txt', 'destination_path': 'copied/nested/b.txt'},
            ]
        }
    )
    pending = session.pending_copy_request
    assert pending is not None

    msg = execute_pending_copy_decision(session, confirm=True, request_id=pending['request_id'])

    assert 'Copied 2 file(s)' in msg
    assert session.pending_copy_request is None
    assert (ws / 'copied' / 'a.txt').read_text(encoding='utf-8') == 'a'
    assert (ws / 'copied' / 'nested' / 'b.txt').read_text(encoding='utf-8') == 'b'


def test_execute_pending_copy_decision_cancel_keeps_files_unchanged(copy_env) -> None:
    ws = copy_env.workspace
    session = copy_env.session
    (ws / 'src.txt').write_text('hello', encoding='utf-8')

    copy_workspace_files.invoke(
        {'copies': [{'source_path': 'src.txt', 'destination_path': 'copy.txt'}]}
    )
    pending = session.pending_copy_request
    assert pending is not None

    msg = execute_pending_copy_decision(session, confirm=False, request_id=pending['request_id'])

    assert msg == 'User cancelled the copy request.'
    assert session.pending_copy_request is None
    assert not (ws / 'copy.txt').exists()


def test_copy_workspace_files_rejects_duplicate_destinations(copy_env) -> None:
    ws = copy_env.workspace
    (ws / 'one.txt').write_text('one', encoding='utf-8')
    (ws / 'two.txt').write_text('two', encoding='utf-8')

    out = copy_workspace_files.invoke(
        {
            'copies': [
                {'source_path': 'one.txt', 'destination_path': 'dup.txt'},
                {'source_path': 'two.txt', 'destination_path': 'dup.txt'},
            ]
        }
    )

    assert 'duplicate destination path' in out
