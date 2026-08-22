"""Conversation timeline file-journal SSE emission."""

from __future__ import annotations

import asyncio

from clara_coder_backend.domain import SessionState
from clara_coder_backend.lang_agent.graph import _hitl_sse_lines
from clara_coder_backend.session.file_journal import emit_edit_journal, emit_file_journal, file_journal_payload
from clara_coder_backend.tools.edit import _finalize_workspace_edit


def test_emit_file_journal_requires_user_turn_id() -> None:
    session = SessionState()
    session.hitl_sse_queue = asyncio.Queue()
    emit_file_journal(
        session,
        file_journal_payload(user_message_id='', op='modify', relative_path='a.ts', before_content='old'),
    )
    assert session.hitl_sse_queue.empty()

    session.current_user_message_id = 'u1'
    emit_edit_journal(session, 'a.ts', 'old', before_existed=True, encoding='utf-8', newline='lf')
    kind, payload = session.hitl_sse_queue.get_nowait()
    assert kind == 'file_journal'
    assert payload['userMessageId'] == 'u1'
    assert payload['op'] == 'modify'
    assert payload['relativePath'] == 'a.ts'
    assert payload['beforeContent'] == 'old'


def test_emit_edit_journal_empty_existing_file_is_modify() -> None:
    session = SessionState()
    session.hitl_sse_queue = asyncio.Queue()
    session.current_user_message_id = 'u1'
    emit_edit_journal(session, 'empty.ts', '', before_existed=True, encoding='utf-8', newline='lf')
    kind, payload = session.hitl_sse_queue.get_nowait()
    assert kind == 'file_journal'
    assert payload['op'] == 'modify'
    assert payload['relativePath'] == 'empty.ts'
    assert payload['beforeContent'] == ''


def test_hitl_sse_lines_file_journal() -> None:
    session = SessionState()
    lines = asyncio.run(
        _hitl_sse_lines(session, ('file_journal', {'userMessageId': 'u1', 'op': 'create', 'relativePath': 'n.ts'}))
    )
    assert len(lines) == 1
    assert 'file_journal' in lines[0]


def test_auto_apply_edit_emits_journal(tmp_path) -> None:
    from clara_coder_backend.session.state import current_session_id, sessions

    root = tmp_path / 'ws'
    root.mkdir()
    target = root / 'a.ts'
    target.write_text('before', encoding='utf-8')
    session = SessionState()
    session.auto_apply_mode = True
    session.current_user_message_id = 'turn-1'
    session.hitl_sse_queue = asyncio.Queue()
    session.workspace_path = str(root)
    sessions['s1'] = session
    token = current_session_id.set('s1')
    try:
        out = _finalize_workspace_edit(
            session, 'a.ts', 'before', 'after', 'full-file', 'utf-8', 'lf', before_existed=True
        )
        assert 'Auto-applied' in out
        kind, payload = session.hitl_sse_queue.get_nowait()
        assert kind == 'file_journal'
        assert payload['beforeContent'] == 'before'
        assert payload['op'] == 'modify'
        assert target.read_text(encoding='utf-8') == 'after'
    finally:
        current_session_id.reset(token)
        sessions.pop('s1', None)
