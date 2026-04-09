"""Safe delete tool helpers."""

from nemo_backend.delete_tool import (
    _reject_reason,
    batch_delete_workspace_entries,
    delete_confirm_sse_payload,
    execute_pending_delete_decision,
)
from nemo_backend.state import current_session_id, get_session


def test_rejects_workspace_root() -> None:
    assert _reject_reason('.') is not None
    assert _reject_reason('') is not None


def test_rejects_git() -> None:
    assert _reject_reason('.git') is not None
    assert _reject_reason('.git/config') is not None


def test_delete_confirm_sse_payload_batch_entries() -> None:
    pending = {
        'request_id': 'r1',
        'batch': True,
        'entries': [
            {'relative_path': 'a.txt', 'kind': 'file', 'recursive': False},
            {'relative_path': 'd', 'kind': 'directory', 'recursive': True},
        ],
    }
    assert delete_confirm_sse_payload(pending) == {
        'version': 1,
        'requestId': 'r1',
        'entries': [
            {'relativePath': 'a.txt', 'kind': 'file', 'recursive': False},
            {'relativePath': 'd', 'kind': 'directory', 'recursive': True},
        ],
    }


def test_batch_delete_auto_apply_deletes(tmp_path) -> None:
    session_id = 'batch-delete-auto'
    root = tmp_path / 'ws'
    root.mkdir()
    (root / 'a.txt').write_text('a', encoding='utf-8')
    (root / 'b.txt').write_text('b', encoding='utf-8')
    token = current_session_id.set(session_id)
    try:
        sess = get_session(session_id)
        sess.workspace_path = str(root.resolve())
        sess.worker_apply_mode = True
        sess.auto_apply_mode = True
        out = batch_delete_workspace_entries.invoke({'relative_paths': ['a.txt', 'b.txt'], 'recursive': False})
        assert 'Deleted' in out
        assert not (root / 'a.txt').exists()
        assert not (root / 'b.txt').exists()
    finally:
        current_session_id.reset(token)


def test_execute_pending_batch_confirm(tmp_path) -> None:
    session_id = 'batch-delete-pending'
    root = tmp_path / 'ws'
    root.mkdir()
    (root / 'a.txt').write_text('a', encoding='utf-8')
    (root / 'sub').mkdir()
    (root / 'sub' / 'c.txt').write_text('c', encoding='utf-8')
    rid = 'req-batch-1'
    token = current_session_id.set(session_id)
    try:
        sess = get_session(session_id)
        sess.workspace_path = str(root.resolve())
        sess.pending_delete_request = {
            'request_id': rid,
            'batch': True,
            'entries': [
                {'relative_path': 'a.txt', 'kind': 'file', 'recursive': False},
                {'relative_path': 'sub/c.txt', 'kind': 'file', 'recursive': False},
            ],
            'workspace_root': str(root.resolve()),
            'session_id': session_id,
        }
        note = execute_pending_delete_decision(sess, confirm=True, request_id=rid)
        assert sess.pending_delete_request is None
        assert not (root / 'a.txt').exists()
        assert not (root / 'sub' / 'c.txt').exists()
        assert (root / 'sub').exists()
        assert 'Deleted' in note
    finally:
        current_session_id.reset(token)
