"""Session teardown shared by /clear, /dispose, and idle eviction."""

from __future__ import annotations

import logging

from clara_coder_backend.domain import SessionState
from clara_coder_backend.session.checkpointing import delete_outer_threads_for_session
from clara_coder_backend.session import state
from clara_coder_backend.staging.staging_snapshot_session import cleanup_staging_snapshot_session
from clara_coder_backend.workspace_index.lifecycle import invalidate_staging_index_disk

logger = logging.getLogger('clara.session.lifecycle')


def clear_session_hitl_fields(sess: SessionState) -> None:
    """Drop live HITL/pause fields without touching workspace or LSP attachment.

    Leaves ``admin_elevation_granted`` in place — that is a standing conversation
    grant (composer Admin chip), not a pending approval card.
    """
    hitl = sess.hitl
    hitl.pending_diff_payload = None
    hitl.pending_staged_transfer_hitl = None
    hitl.pending_staged_transfer_batch_payload = None
    hitl.pending_delete_request = None
    hitl.pending_copy_request = None
    hitl.pending_accept_command_request = None
    hitl.pending_plan_confirm_request = None
    hitl.plan_execute_aborted = False
    hitl.pending_question_request = None
    hitl.question_answers = None
    hitl.question_aborted = False
    pause = hitl.agent_pause_event
    if pause is not None and not pause.is_set():
        pause.set()
    hitl.agent_pause_event = None
    hitl.agent_pause_note = None
    hitl.pending_user_event_notes.clear()
    hitl.hitl_sse_queue = None


async def teardown_session(sid: str) -> None:
    """Release staging, background commands, write jobs, and outer checkpoints for a session id.

    Does not mutate ``state.sessions`` — callers reset (``/clear``) or pop (``/dispose``).
    """
    try:
        invalidate_staging_index_disk(sid)
    except Exception:
        logger.debug('invalidate staging semantic index on teardown failed', exc_info=True)
    sess = state.sessions.get(sid)
    if sess is not None:
        cleanup_staging_snapshot_session(sess, sid)
    from clara_coder_backend.tools.run_command import kill_session_background_commands
    from clara_coder_backend.tools.write_jobs import cancel_session_write_jobs

    await kill_session_background_commands(sid)
    await cancel_session_write_jobs(sid)
    await delete_outer_threads_for_session(sid)
