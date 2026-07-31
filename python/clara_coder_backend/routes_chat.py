"""Chat streaming and agent continuation routes."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from clara_coder_backend.agent import stream_agent_reply
from clara_coder_backend.chat_input import effective_user_message_content
from clara_coder_backend.schemas import (
    AbortRequest,
    AgentContinueRequest,
    AgentQuestionAnswersRequest,
    BackgroundCommandTerminalClosedRequest,
    ChatRequest,
)
from clara_coder_backend import state

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
        request.speech_enabled,
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


@router.post('/chat/background-command-terminal-closed')
async def background_command_terminal_closed(
    request: BackgroundCommandTerminalClosedRequest,
) -> dict[str, bool | str]:
    """User closed a run_command terminal tab: kill the job and queue an agent note."""
    from clara_coder_backend.tools.run_command import handle_background_command_terminal_closed

    ok, detail = await handle_background_command_terminal_closed(
        request.session_id,
        request.command_id,
    )
    return {'ok': ok, 'detail': detail}


@router.post('/chat/agent-question-answers')
async def agent_question_answers(request: AgentQuestionAnswersRequest) -> dict[str, bool | str]:
    """Resolve a plan-mode question card and resume the paused planner stream."""
    from clara_coder_backend.agent_question import execute_pending_question_decision

    sess = state.get_session(request.session_id)
    note = execute_pending_question_decision(
        sess,
        action=request.action,
        request_id=request.request_id or None,
        answers=[ans.model_dump() for ans in request.answers],
    )
    sess.agent_pause_note = note
    ev = sess.agent_pause_event
    if ev is not None:
        ev.set()
    return {'ok': True}


@router.post('/chat/agent-continue')
async def agent_continue(request: AgentContinueRequest) -> dict[str, bool | str]:
    """Unblock an agent stream that is waiting after a diff or approval/confirmation step."""
    from clara_coder_backend.accept_command import execute_pending_accept_command_decision
    from clara_coder_backend.tools.review_tools import (
        finalize_staged_transfer_after_hitl,
        resolve_staged_transfer_batch_file,
    )
    from clara_coder_backend.tools.copy import execute_pending_copy_decision
    from clara_coder_backend.tools.delete import execute_pending_delete_decision

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
        from clara_coder_backend.plan_confirm import execute_pending_plan_confirm_decision

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
