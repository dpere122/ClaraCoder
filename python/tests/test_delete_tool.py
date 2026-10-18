"""Delete tool: immediate journaled deletes, and a confirm card only for directories too large to restore."""

from __future__ import annotations

import asyncio

from clara_coder_backend.session import file_journal
from clara_coder_backend.tools.delete import (
    _reject_reason,
    delete_confirm_sse_payload,
    delete_workspace_entries,
    execute_pending_delete_decision,
)


def _journal_rows(session) -> list[dict]:
    rows = []
    while not session.hitl_sse_queue.empty():
        kind, payload = session.hitl_sse_queue.get_nowait()
        if kind == 'file_journal':
            rows.append(payload)
    return rows


def test_rejects_workspace_root() -> None:
    assert _reject_reason('.') is not None
    assert _reject_reason('') is not None


def test_rejects_git() -> None:
    assert _reject_reason('.git') is not None
    assert _reject_reason('.git/config') is not None


def test_delete_confirm_sse_payload_entries() -> None:
    pending = {
        'request_id': 'r1',
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


def test_deletes_immediately_and_journals_before_content(workspace_env) -> None:
    ws = workspace_env.workspace
    session = workspace_env.session
    session.hitl_sse_queue = asyncio.Queue()
    (ws / 'a.txt').write_text('a', encoding='utf-8')
    (ws / 'd').mkdir()
    (ws / 'd' / 'b.txt').write_text('b', encoding='utf-8')

    out = delete_workspace_entries.invoke({'relative_paths': ['a.txt', 'd'], 'recursive': True})

    assert 'Deleted' in out, out
    assert not (ws / 'a.txt').exists()
    assert not (ws / 'd').exists()
    rows = {r['relativePath']: r for r in _journal_rows(session)}
    assert rows['a.txt']['op'] == 'delete'
    assert rows['a.txt']['beforeContent'] == 'a'
    assert rows['d']['op'] == 'delete-tree'
    assert rows['d']['treeEntries'][0]['content'] == 'b'
    assert session.pending_delete_request is None


def test_non_empty_directory_needs_recursive(workspace_env) -> None:
    ws = workspace_env.workspace
    (ws / 'd').mkdir()
    (ws / 'd' / 'x.txt').write_text('x', encoding='utf-8')
    out = delete_workspace_entries.invoke({'relative_paths': ['d']})
    assert out.startswith('Tool error:')
    assert (ws / 'd' / 'x.txt').exists()


def test_unrestorable_directory_asks_first(workspace_env, monkeypatch) -> None:
    ws = workspace_env.workspace
    session = workspace_env.session
    monkeypatch.setattr(file_journal, 'TREE_SNAPSHOT_MAX_FILES', 1)
    (ws / 'big').mkdir()
    for i in range(3):
        (ws / 'big' / f'{i}.txt').write_text(str(i), encoding='utf-8')

    out = delete_workspace_entries.invoke({'relative_paths': ['big'], 'recursive': True})

    assert 'Pending user confirmation' in out
    assert (ws / 'big').exists()
    pending = session.pending_delete_request
    assert pending is not None

    note = execute_pending_delete_decision(session, confirm=True, request_id=pending['request_id'])
    assert 'Deleted directory `big`' in note
    assert not (ws / 'big').exists()
    assert session.pending_delete_request is None


def test_dependency_directory_is_never_journaled(workspace_env) -> None:
    ws = workspace_env.workspace
    (ws / 'pkg' / 'node_modules').mkdir(parents=True)
    out = delete_workspace_entries.invoke({'relative_paths': ['pkg'], 'recursive': True})
    assert 'Pending user confirmation' in out
    assert 'node_modules' in out


def test_cancel_keeps_files(workspace_env, monkeypatch) -> None:
    ws = workspace_env.workspace
    session = workspace_env.session
    monkeypatch.setattr(file_journal, 'TREE_SNAPSHOT_MAX_FILES', 0)
    (ws / 'big').mkdir()
    (ws / 'big' / 'a.txt').write_text('a', encoding='utf-8')
    delete_workspace_entries.invoke({'relative_paths': ['big'], 'recursive': True})
    pending = session.pending_delete_request

    note = execute_pending_delete_decision(session, confirm=False, request_id=pending['request_id'])

    assert note == 'User cancelled the delete request.'
    assert (ws / 'big' / 'a.txt').exists()
