"""Chat streaming and agent continuation routes."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from nemo_backend.agent import stream_agent_reply
from nemo_backend.chat_input import effective_user_message_content
from nemo_backend.schemas import AbortRequest, AgentContinueRequest, ChatRequest
from nemo_backend import state

router = APIRouter()


@router.post('/chat/stream')
async def chat_stream(request: ChatRequest) -> StreamingResponse:
    """Stream assistant reply as Server-Sent Events (status + chunk + [DONE])."""
    ck = (request.checkpoint_id or '').strip() or None
    user_content = effective_user_message_content(request.message, request.structured_content)
    generator = stream_agent_reply(
        request.session_id,
        user_content,
        request.apply_mode,
        request.auto_apply_mode,
        ck,
        request.composer_mode,
    )
    return StreamingResponse(generator, media_type='text/event-stream')


@router.post('/chat/abort')
async def chat_abort(request: AbortRequest) -> dict[str, bool]:
    """Signal the in-flight stream for a session to stop as soon as possible."""
    sess = state.get_session(request.session_id)
    sess.abort_event.set()
    # Also unblock any HITL pause so the generator can exit.
    ev = sess.agent_pause_event
    if ev is not None:
        ev.set()
    return {'ok': True}


@router.post('/chat/agent-continue')
async def agent_continue(request: AgentContinueRequest) -> dict[str, bool | str]:
    """Unblock an agent stream that is waiting after a diff or approval/confirmation step."""
    from nemo_backend.accept_command import execute_pending_accept_command_decision
    from nemo_backend.agents.specialists.review_tools import (
        finalize_staged_transfer_after_hitl,
        resolve_staged_transfer_batch_file,
    )
    from nemo_backend.copy_tool import execute_pending_copy_decision
    from nemo_backend.delete_tool import execute_pending_delete_decision

    sess = state.get_session(request.session_id)
    note = (request.note or '').strip()
    batch_complete = True
    if request.delete_action:
        extra = execute_pending_delete_decision(
            sess,
            confirm=request.delete_action == 'confirm',
            request_id=request.delete_request_id or None,
        )
        note = extra if extra else note
    elif request.copy_action:
        extra = execute_pending_copy_decision(
            sess,
            confirm=request.copy_action == 'confirm',
            request_id=request.copy_request_id or None,
        )
        note = extra if extra else note
    elif request.accept_command_action:
        extra = await execute_pending_accept_command_decision(
            sess,
            confirm=request.accept_command_action == 'confirm',
            request_id=request.accept_command_request_id or None,
        )
        note = extra if extra else note
    elif request.staged_transfer_action:
        rel_path = (request.staged_transfer_path or '').strip().replace('\\', '/')
        req_id = (request.staged_transfer_request_id or '').strip()
        if rel_path and req_id:
            batch_complete, extra = resolve_staged_transfer_batch_file(
                sess,
                request_id=req_id,
                relative_path=rel_path,
                action=request.staged_transfer_action,
                user_note=note,
                session_id=request.session_id,
            )
            if extra and not batch_complete:
                return {'ok': False, 'batchComplete': False}
            if extra:
                note = extra
        else:
            extra = finalize_staged_transfer_after_hitl(
                sess,
                request.staged_transfer_action,
                note,
                session_id=request.session_id,
            )
            if extra:
                if request.staged_transfer_action == 're_review':
                    note = extra
                else:
                    note = f'{extra}\n\n{note}'.strip() if note else extra
    elif request.plan_confirm_action:
        from nemo_backend.plan_confirm import execute_pending_plan_confirm_decision

        extra = execute_pending_plan_confirm_decision(
            sess,
            confirm=request.plan_confirm_action == 'confirm',
            request_id=request.plan_confirm_request_id or None,
        )
        note = extra if extra else note
    if batch_complete:
        sess.agent_pause_note = note
        ev = sess.agent_pause_event
        if ev is not None:
            ev.set()
    return {'ok': True, 'batchComplete': batch_complete}
