"""Chat streaming and agent continuation routes.

``/chat/stream`` runs each turn detached from the request and serialized per session
(:mod:`clara_coder_backend.session.turns`). Sub-agent session ids are never streamed directly; their
events go on the sub-agent bus (``GET /subagents/events``). They are still valid targets for
``/chat/abort`` (stop one sub-agent) and ``/chat/agent-continue`` (answer its approval card); a retired
one is never recreated.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from starlette.types import Receive, Scope, Send

from clara_coder_backend.composer import stream_agent_reply
from clara_coder_backend.domain import SessionState
from clara_coder_backend.lang_agent.subagents import (
    abort_subagent,
    is_subagent_session_id,
    maybe_publish_results_ready,
    subagent_session,
)
from clara_coder_backend.llm.http_transport import abort_in_flight_generation
from clara_coder_backend.session.chat_input import effective_user_message_content
from clara_coder_backend.session.schemas import (
    AbortRequest,
    AgentContinueRequest,
    AgentQuestionAnswersRequest,
    BackgroundCommandTerminalClosedRequest,
    ChatRequest,
)
from clara_coder_backend.session import state
from clara_coder_backend.session.turns import serve_turn
from clara_coder_backend.session.user_events import record_superseded_turn
router = APIRouter()


class _TurnStreamingResponse(StreamingResponse):
    """Streams a detached turn; however the response ends, the turn learns whether its client left.

    Starlette never closes the body iterator, so a disconnect would otherwise only reach the turn
    when the relay is garbage-collected.
    """

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            detach = getattr(self.body_iterator, 'detach', None)
            if callable(detach):
                detach()


@router.post('/chat/stream')
async def chat_stream(request: ChatRequest) -> StreamingResponse:
    """Stream assistant reply as Server-Sent Events (status + chunk + [DONE]).

    A turn still running on this session is interrupted first (see :func:`serve_turn`). A turn with
    ``continue_with_subagent_results`` (Electron, after ``subagent_results_ready``) takes its input from
    the waiting sub-agent reports instead of ``message``, and queues behind a running turn rather than
    interrupting it.
    """
    sid = request.session_id
    if is_subagent_session_id(sid):
        raise HTTPException(status_code=400, detail='Sub-agent conversations are read-only.')
    ck = (request.checkpoint_id or '').strip() or None
    continuing = bool(request.continue_with_subagent_results)
    user_content = '' if continuing else effective_user_message_content(request.message, request.structured_content)

    def make_turn():  # noqa: ANN202 — the composer's SSE generator
        return stream_agent_reply(
            sid,
            user_content,
            request.apply_mode,
            request.auto_apply_mode,
            ck,
            request.composer_mode,
            request.speech_enabled,
            request.tts_provider,
            request.user_message_id,
            request.admin_elevation_granted,
            request.workspace_notes,
            continue_with_subagent_results=continuing,
        )

    def on_superseded() -> None:
        sess = state.sessions.get(sid)
        if sess is not None:
            record_superseded_turn(sess, user_content)

    def on_abandoned() -> None:
        # Its client left before it started (e.g. Stop right after sending) and no turn replaced it: the
        # turn it interrupted left waiting sub-agent reports to it, so announce them now.
        maybe_publish_results_ready(sid, ending_turn=True)

    return _TurnStreamingResponse(
        # A replaced continue turn records nothing: the reports wait for the turn that replaced it.
        serve_turn(
            sid,
            make_turn,
            on_superseded=None if continuing else on_superseded,
            on_abandoned=on_abandoned,
            preempt=not continuing,
        ),
        media_type='text/event-stream',
    )


@router.post('/chat/abort')
async def chat_abort(request: AbortRequest) -> dict[str, bool]:
    """Stop the in-flight stream and disconnect llama-server token generation.

    A main session's id stops only its own turn: its sub-agents keep running. A sub-agent id stops
    only that sub-agent (its partial report is delivered to the main agent).
    """
    sid = request.session_id
    if is_subagent_session_id(sid):
        await abort_subagent(sid)
        return {'ok': True}
    sess = state.get_session(sid)
    await abort_in_flight_generation(sess, sid)
    return {'ok': True}


@router.post('/chat/background-command-terminal-closed')
async def background_command_terminal_closed(
    request: BackgroundCommandTerminalClosedRequest,
) -> dict[str, bool | str]:
    """User closed a run_command terminal tab: kill the job and queue an agent note."""
    from clara_coder_backend.tools.run_command import handle_background_command_terminal_closed

    if is_subagent_session_id(request.session_id) and subagent_session(request.session_id) is None:
        return {'ok': False, 'detail': 'That sub-agent has finished; its commands were stopped.'}
    ok, detail = await handle_background_command_terminal_closed(
        request.session_id,
        request.command_id,
    )
    return {'ok': ok, 'detail': detail}


@router.post('/chat/agent-question-answers')
async def agent_question_answers(request: AgentQuestionAnswersRequest) -> dict[str, bool | str]:
    """Resolve a plan-mode question card and resume the paused planner stream."""
    from clara_coder_backend.lang_agent.question import execute_pending_question_decision

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


def _answers_another_request(sess: SessionState, request: AgentContinueRequest) -> bool:
    """True when the answer names a request other than the one this card kind is waiting on.

    Review cards from parallel tool calls are shown one at a time, so another call's request
    can be waiting by the time a stale answer arrives.
    """

    for action, request_id, pending in (
        (request.delete_action, request.delete_request_id, sess.pending_delete_request),
        (request.accept_command_action, request.accept_command_request_id, sess.pending_accept_command_request),
    ):
        if action:
            rid = (request_id or '').strip()
            return bool(rid) and pending is not None and pending.get('request_id') != rid
    return False


def _session_waiting_on(sess: SessionState, request: AgentContinueRequest) -> SessionState:
    """The session whose card this answer names: ``sess``, or one of its running sub-agents.

    Electron answers a sub-agent's card with the child's id; an answer sent with the parent's id
    instead still reaches the child that is waiting on that request id.
    """
    for action, request_id, slot in (
        (request.delete_action, request.delete_request_id, 'pending_delete_request'),
        (request.accept_command_action, request.accept_command_request_id, 'pending_accept_command_request'),
    ):
        if not action:
            continue
        rid = (request_id or '').strip()
        pending = getattr(sess, slot)
        if not rid or (pending is not None and pending.get('request_id') == rid):
            return sess
        for child_id in list(sess.subagent_children):
            child = subagent_session(child_id)
            waiting = getattr(child, slot) if child is not None else None
            if waiting is not None and waiting.get('request_id') == rid:
                return child
        return sess
    return sess


@router.post('/chat/agent-continue')
async def agent_continue(request: AgentContinueRequest) -> dict[str, bool | str]:
    """Unblock an agent stream that is waiting on an approval/confirmation card."""
    from clara_coder_backend.hitl.accept_command import execute_pending_accept_command_decision
    from clara_coder_backend.tools.delete import execute_pending_delete_decision

    if is_subagent_session_id(request.session_id):
        named = subagent_session(request.session_id)
        if named is None:
            return {'ok': False, 'batchComplete': True, 'detail': 'That sub-agent has finished.'}
    else:
        named = state.get_session(request.session_id)
    sess = _session_waiting_on(named, request)
    if _answers_another_request(sess, request):
        # A late or duplicate answer must not resolve (or clear) the card that is waiting now.
        return {'ok': False, 'batchComplete': True, 'detail': 'This request is no longer waiting for an answer.'}
    note = (request.note or '').strip()
    if request.delete_action:
        extra = execute_pending_delete_decision(
            sess,
            confirm=request.delete_action == 'confirm',
            request_id=request.delete_request_id or None,
        )
        note = extra if extra else note
    elif request.accept_command_action:
        extra = await execute_pending_accept_command_decision(
            sess,
            confirm=request.accept_command_action in ('confirm', 'confirm_session'),
            request_id=request.accept_command_request_id or None,
            grant_session=request.accept_command_action == 'confirm_session',
            remember_deny=request.accept_command_action == 'deny',
        )
        note = extra if extra else note
    elif request.plan_confirm_action:
        from clara_coder_backend.plan.plan_confirm import execute_pending_plan_confirm_decision

        extra = execute_pending_plan_confirm_decision(
            sess,
            confirm=request.plan_confirm_action == 'confirm',
            request_id=request.plan_confirm_request_id or None,
        )
        note = extra if extra else note
    sess.agent_pause_note = note
    ev = sess.agent_pause_event
    if ev is not None:
        ev.set()
    return {'ok': True, 'batchComplete': True}
