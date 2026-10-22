"""Conversation timeline file-journal SSE emission."""

from __future__ import annotations

import asyncio
import threading
import time

from clara_coder_backend.domain import SessionState
from clara_coder_backend.lang_agent.graph import _hitl_sse_lines
from clara_coder_backend.session.file_journal import emit_edit_journal, emit_file_journal, file_journal_payload
from clara_coder_backend.tools.edit import write_workspace_file


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


def test_journal_from_a_worker_thread_wakes_the_stream_loop() -> None:
    """A tool thread hands the row to the loop that owns the queue, so a waiting ``queue.get()`` wakes up."""

    async def main() -> None:
        loop = asyncio.get_running_loop()
        session = SessionState()
        session.hitl_sse_queue = asyncio.Queue()
        session.hitl_sse_loop = loop
        session.current_user_message_id = 'u1'

        def tool_thread() -> None:
            time.sleep(0.2)  # Post once the loop is idle in its selector, as a tool mid-turn would.
            emit_edit_journal(session, 'w.ts', 'old', before_existed=True, encoding='utf-8', newline='lf')

        worker = threading.Thread(target=tool_thread)
        started = time.monotonic()
        worker.start()
        # Nothing else wakes this idle loop: a bare ``put_nowait`` from the thread would only be seen when the
        # 5 s timeout fires, while ``call_soon_threadsafe`` wakes it at once.
        kind, payload = await asyncio.wait_for(session.hitl_sse_queue.get(), timeout=5.0)
        elapsed = time.monotonic() - started
        worker.join()
        assert (kind, payload['relativePath'], payload['beforeContent']) == ('file_journal', 'w.ts', 'old')
        assert elapsed < 2.0, f'stream loop woke only after {elapsed:.1f}s'

        # On the loop's own thread the row is queued right away.
        emit_edit_journal(session, 'x.ts', 'x', before_existed=True, encoding='utf-8', newline='lf')
        assert session.hitl_sse_queue.get_nowait()[1]['relativePath'] == 'x.ts'

    asyncio.run(main())


def test_hitl_sse_lines_file_journal() -> None:
    session = SessionState()
    lines = asyncio.run(
        _hitl_sse_lines(session, ('file_journal', {'userMessageId': 'u1', 'op': 'create', 'relativePath': 'n.ts'}))
    )
    assert len(lines) == 1
    assert 'file_journal' in lines[0]


def test_edit_emits_journal_once_per_turn(workspace_env) -> None:
    session = workspace_env.session
    session.hitl_sse_queue = asyncio.Queue()
    target = workspace_env.workspace / 'a.ts'
    target.write_text('before', encoding='utf-8')

    write_workspace_file.invoke({'relative_path': 'a.ts', 'content': 'after'})
    write_workspace_file.invoke({'relative_path': 'a.ts', 'content': 'after again'})

    kind, payload = session.hitl_sse_queue.get_nowait()
    assert kind == 'file_journal'
    assert payload['beforeContent'] == 'before'
    assert payload['op'] == 'modify'
    assert session.hitl_sse_queue.empty()
    assert target.read_text(encoding='utf-8') == 'after again'
