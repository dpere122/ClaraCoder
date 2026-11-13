"""Keep every model call inside the context window without rewriting the checkpoint.

:class:`ContextCompactionMiddleware` is the innermost model wrapper. Before a call it renders the view from
the thread's private ``context_compaction`` state (:mod:`~clara_coder_backend.lang_agent.context_compaction`)
and, when the prompt nears the window, runs an *event*: a new cut and elisions, fresh notes from the model,
a new block. Between events the view is byte-stable, so a local server keeps its prefix. A prompt the server
still rejects is compacted harder and retried; the third rejection fails the turn as before.

Also, whether compaction is on or off:

- A reply cut off at the output limit is discarded before any hook can act on it, tool calls included,
  and the turn ends with a notice (or with the reply's plain text and a note, when that is all it held).
  The model is never sent a message about it.
- A tool result that would not fit the window is shortened (the wrapper sits outside the approval reviews
  so approved command output counts).
- ``llama-server`` gets a per-step thinking bound.

With compaction on and a cut in place, an edit based on text the model no longer has is refused.
"""

from __future__ import annotations

import itertools
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated, Any

from langchain.agents.middleware import AgentMiddleware, hook_config
from langchain.agents.middleware.types import (
    AgentState,
    ExtendedModelResponse,
    ModelResponse,
    PrivateStateAttr,
    ResponseT,
)
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.runtime import Runtime
from langgraph.types import Command
from langgraph.typing import ContextT
from typing_extensions import NotRequired, override

from clara_coder_backend.config import CLARA_CONTEXT_WINDOW_FALLBACK
from clara_coder_backend.domain import RuntimeConnection, SessionState
from clara_coder_backend.lang_agent.context_compaction import (
    CHARS_PER_TOKEN,
    NOTES_EVERY_CALLS,
    GUARDED_EDIT_TOOLS,
    SOFT_EVENT_GAP_RATIO,
    Budget,
    accepted_notes,
    notes_allowance_chars,
    notes_output_tokens,
    block_text,
    bounded_step_settings,
    build_digest,
    choose_cut,
    choose_elisions,
    compaction_due,
    compute_budget,
    continuation_request,
    corrected_ratio,
    digest_cap_chars,
    estimate_prompt_tokens,
    futile_hint,
    internal_call,
    kept_messages,
    message_chars,
    overflow_elisions,
    overflow_info,
    packs_out_of_view,
    pinned_request,
    prompt_overhead_chars,
    render_view,
    request_cap_chars,
    stale_edit_refusal,
    summary_prompt,
    tail_from,
    tool_output_cap_chars,
    truncate_tool_result,
)
from clara_coder_backend.lang_agent.streaming import status_event
from clara_coder_backend.llm.gemma_output import gemma_reply_is_empty
from clara_coder_backend.llm.langchain_compat import output_was_truncated
from clara_coder_backend.llm.messages import (
    assistant_visible_answer,
    is_user_turn,
    reasoning_sidecar_text,
    stringify_content,
    text_uses_pseudo_tool_markup,
)
from clara_coder_backend.llm.model_tuning import gemma_optimize_profile_active
from clara_coder_backend.logging.llm_interaction_logging import log_llm_call_stats
from clara_coder_backend.session import state as session_state
from clara_coder_backend.session.state import current_session_id, get_active_connection, runtime_config
from clara_coder_backend.workspace.paths import normalize_relative_path

logger = logging.getLogger('clara.agent.compaction')

#: Label of the status pill an event shows (a normal tool status on the turn's stream).
COMPACT_PILL_LABEL = 'compact_context'

_EMPTY_REPLY_STOP_TEXT = (
    'Stopped: the model returned empty replies several times in a row. Try again, or rephrase the request.'
)
_TRUNCATED_STOP_TEXT = (
    'Stopped: the model hit its output limit, so that reply was discarded and nothing from it ran. Ask for a '
    'smaller step, or raise the output limit or context size in Settings.'
)
_TRUNCATED_ANSWER_NOTE = '[Cut off at the output limit. Ask to continue, or raise the limit in Settings.]'
_FUTILE_STOP_TEXT = (
    'Stopped: the context filled up again and again with nothing new edited, run or read, so going on would '
    'only repeat the same work. Ask for a narrower step, or start a new conversation.'
)

#: Draws of an empty Gemma reply before it is treated as a reply at all: the prompt is cached, so one costs a second.
_EMPTY_REPLY_REDRAWS = 3
#: A truncated reply this close to the window forces compaction on the next call (the context, not the
#: output cap, cut it), so asking to continue has room.
_TRUNCATED_FORCE_RATIO = 0.9
#: Events in a row without progress before the turn is stopped.
_FUTILE_STOP = 3
#: Share of the budgeted tail kept when a view overflowed twice.
_OVERFLOW_TAIL_FACTOR = 0.5
_OVERFLOW_LEVELS = 2

_status_ids = itertools.count(1)


class _CompactionState(AgentState[ResponseT]):
    """One thread's compaction state; whole-dict replace, from the model wrapper and after-model hooks only.

    ``{cut_id, block, hint, notes, elided_ids, floor_id, window, window_for, next_soft, notes_call, futile,
    progress, force}``. Never written from tools: parallel writes raise ``InvalidUpdateError``.
    """

    context_compaction: NotRequired[Annotated[dict[str, Any], PrivateStateAttr]]


class _StoppedDuringCompaction(Exception):
    """The user stopped the turn during an event, with no failed call to re-raise: no further request may go out.

    Not ``CancelledError`` (LangGraph would turn it into its own error); the runner settles on the abort event.
    """


def _current_session() -> SessionState | None:
    sid = (current_session_id.get() or '').strip()
    return session_state.sessions.get(sid) if sid else None


def _active_connection() -> RuntimeConnection | None:
    try:
        return get_active_connection()
    except Exception:
        return None


def _window_key(connection: RuntimeConnection | None) -> list[Any] | None:
    """What a window learned from an overflow belongs to. A list: the checkpoint turns a tuple into one."""
    return [connection.id, connection.model, connection.context_window_tokens] if connection is not None else None


def _thread_window(cc: dict[str, Any], connection: RuntimeConnection | None) -> int:
    """A server's own ``n_ctx`` from an overflow on this connection as it is now, else Settings, else the fallback."""
    configured = connection.context_window_tokens if connection is not None else 0
    learned = cc.get('window') if cc.get('window_for') == _window_key(connection) else 0
    return int(learned or configured or CLARA_CONTEXT_WINDOW_FALLBACK)


def _emit_status(
    session: SessionState,
    status_id: str,
    detail: str,
    pill_state: str,
    *,
    duration_ms: int | None = None,
) -> None:
    """Queue the event's pill on the turn's stream (relayed by the nested-queue passthrough)."""
    queue = session.planning_nested_events_q
    if queue is None:
        return
    payload = status_event(
        status_id, COMPACT_PILL_LABEL, detail=detail, state=pill_state, source='tool', duration_ms=duration_ms
    )
    queue.put_nowait((f'compact:{status_id}', {'event': 'subagent_sse', 'data': payload}))


def _emit_compressed(session: SessionState, before: int, after: int, tool_messages: int, rounds: int) -> None:
    """``context_compressed`` for the context meter; tokens are absolute full-prompt estimates."""
    queue = session.hitl_sse_queue
    if queue is None:
        return
    queue.put_nowait(
        (
            'context_compressed',
            {
                'type': 'context_compressed',
                'tokens_before': before,
                'tokens_after': after,
                'tool_messages_compacted': tool_messages,
                'tool_rounds_dropped': rounds,
            },
        )
    )


def _thousands(tokens: int) -> str:
    return f'{tokens / 1000:.1f}K'


def _last_reasoning(messages: list[BaseMessage]) -> str:
    for message in reversed(messages):
        if isinstance(message, AIMessage):
            reasoning = reasoning_sidecar_text(message)
            if reasoning:
                return reasoning
    return ''


def _capped_message(message: ToolMessage, name: str, cap: int) -> ToolMessage:
    body = stringify_content(message.content)
    capped = truncate_tool_result(name, body, cap)
    return message if capped is body else message.model_copy(update={'content': capped})


def _capped_result(result: ToolMessage | Command, name: str, cap: int) -> ToolMessage | Command:
    if isinstance(result, ToolMessage):
        return _capped_message(result, name, cap)
    update = getattr(result, 'update', None)
    if not isinstance(update, dict) or not isinstance(update.get('messages'), list):
        return result
    messages = update['messages']
    capped = [
        _capped_message(message, name, cap) if isinstance(message, ToolMessage) else message for message in messages
    ]
    if all(new is old for new, old in zip(capped, messages)):
        return result
    return Command(update={**update, 'messages': capped})


def _calls_in_step(messages: list[BaseMessage]) -> int:
    """How many tool calls the step running now made."""
    for message in reversed(messages):
        if isinstance(message, AIMessage):
            return max(1, len(message.tool_calls))
    return 1


def _resolved_edit(call: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    """``call`` with its path as a read shows it (the tools also take absolute ones), and whether that file has text."""
    session = _current_session()
    args = call.get('args')
    if call.get('name') not in GUARDED_EDIT_TOOLS or session is None or not session.workspace_path:
        return call, True
    if not isinstance(args, dict):
        return call, True
    if not (isinstance(args.get('relative_path'), str) and args['relative_path'].strip()):
        return call, True
    root = Path(session.workspace_path)
    try:
        target = normalize_relative_path(root, str(args.get('relative_path') or ''))
        relative = target.relative_to(root.resolve()).as_posix()
        return {**call, 'args': {**args, 'relative_path': relative}}, target.exists() and target.stat().st_size > 0
    except (ValueError, OSError):
        # The tool reports a bad path itself.
        return call, False


def _is_empty_gemma_reply(message: AIMessage) -> bool:
    connection = _active_connection()
    if connection is None or not gemma_optimize_profile_active(connection):
        return False
    if message.tool_calls or (getattr(message, 'invalid_tool_calls', None) or ()):
        return False
    return gemma_reply_is_empty(stringify_content(message.content), reasoning_sidecar_text(message))


def _turn_just_started(messages: list[BaseMessage]) -> bool:
    """No model reply since the last user turn (notes and reports may have come after it)."""
    for message in reversed(messages):
        if not isinstance(message, HumanMessage):
            return False
        if is_user_turn(message):
            return True
    return False


def _current_turn(messages: list[BaseMessage]) -> list[BaseMessage]:
    """From the last user turn on; all of them when none is tagged."""
    for index in range(len(messages) - 1, -1, -1):
        if is_user_turn(messages[index]):
            return messages[index:]
    return messages


def _truncated_stop_text(message: AIMessage) -> str:
    """The cut-off reply's plain text with a note. Nothing else in it is an answer (calls, tool markup, reasoning)."""
    visible = assistant_visible_answer(message)
    if (
        not visible
        or message.tool_calls
        or (getattr(message, 'invalid_tool_calls', None) or ())
        or text_uses_pseudo_tool_markup(visible)
        or '<tool_call' in visible
    ):
        return _TRUNCATED_STOP_TEXT
    return f'{visible}\n\n{_TRUNCATED_ANSWER_NOTE}'


@dataclass
class _ModelCall:
    """One ``awrap_model_call``: what it was given, and the view it will send."""

    request: Any
    handler: Callable[[Any], Awaitable[Any]]
    session: SessionState
    connection: RuntimeConnection | None
    cc: dict[str, Any]
    overhead_chars: int
    pin_ratio: float
    view: list[BaseMessage] = field(default_factory=list)
    est: int = 0
    ratio: float = CHARS_PER_TOKEN
    progress_checked: bool = False

    @property
    def provider(self) -> str:
        return self.connection.provider if self.connection is not None else ''

    @property
    def window(self) -> int:
        return _thread_window(self.cc, self.connection)

    @property
    def request_cap(self) -> int:
        return request_cap_chars(self.window, self.pin_ratio)

    @property
    def raw_messages(self) -> list[BaseMessage]:
        """The checkpoint's order, without per-call notes (``request.messages`` has both changed)."""
        return self.request.state.get('messages') or self.request.messages

    def tokens_of(self, view: list[BaseMessage]) -> int:
        return int((self.overhead_chars + sum(message_chars(message) for message in view)) / self.ratio)

    def agent_request(self) -> Any:
        return self.request.override(
            messages=self.view,
            model_settings=bounded_step_settings(self.request, self.provider, self.window, self.est),
        )

    def budget(self, pin_chars: int, notes_chars: int, digest_chars: int) -> Budget:
        return compute_budget(
            self.window,
            self.overhead_chars / self.ratio,
            pin_chars / self.ratio,
            notes_chars / self.ratio,
            digest_chars / self.ratio,
            runtime_config.context_compression,
        )


class ContextCompactionMiddleware(AgentMiddleware):
    """Render the view, run compaction events and the overflow retry, drop truncated replies, budget tool results.

    Listed right after the vision middleware: innermost model wrapper (it sees the reordered batch and the
    per-call notes), first after-model hook (it sees raw output before tool-call promotion), and a tool wrapper
    outside the approval reviews.
    """

    state_schema = _CompactionState  # type: ignore[assignment]

    def __init__(self, *, pin_ratio: float = 0.25) -> None:
        super().__init__()
        self._pin_ratio = pin_ratio
        # Per graph, so per turn: the system prompt and the tools do not change within one.
        self._overhead_chars: int | None = None
        self._warned_small_window = False

    def _overhead(self, request: Any) -> int:
        if self._overhead_chars is None:
            self._overhead_chars = prompt_overhead_chars(request.system_message, request.tools)
        return self._overhead_chars

    @override
    async def awrap_model_call(self, request: Any, handler: Callable[[Any], Awaitable[Any]]) -> Any:
        session = _current_session()
        if session is None:
            return await handler(request)
        # A further model call means the harness did not end the turn (the sub-agent wait sent its stop back).
        session.harness_final_text = ''
        saved = request.state.get('context_compaction') or {}
        cc = dict(saved)
        call = _ModelCall(
            request=request,
            handler=handler,
            session=session,
            connection=_active_connection(),
            cc=cc,
            overhead_chars=self._overhead(request),
            pin_ratio=self._pin_ratio,
        )
        if _turn_just_started(call.raw_messages):
            # A new request: nothing of the last turn's progress applies to it.
            if cc.get('futile'):
                cc['futile'] = 0
            cc.pop('progress', None)
            hint = cc.pop('hint', '')
            if hint:
                # The one change to a block between events: this re-decodes from the first kept message, once.
                cc['block'] = str(cc.get('block') or '').replace(f'\n\n{hint}', '', 1)
        call.view = render_view(request.messages, cc, call.request_cap)
        call.est, call.ratio = estimate_prompt_tokens(call.view, cc, call.overhead_chars)
        enabled = runtime_config.context_compression.enabled
        block_chars = len(str(cc.get('block') or ''))
        if enabled and compaction_due(call.est, call.budget(0, block_chars, 0), cc):
            await self._compact(call)
        level = 0
        while True:
            if int(cc.get('futile') or 0) >= _FUTILE_STOP:
                return self._futile_stop(call)
            try:
                response = await self._model_reply(call)
                break
            except Exception as exc:
                info = overflow_info(exc) if enabled else None
                if info is None or session.abort_event.is_set():
                    raise
                level = await self._compact_after_overflow(call, info, level)
                if level == 0:
                    raise
        if cc == saved:
            return response
        return ExtendedModelResponse(model_response=response, command=Command(update={'context_compaction': cc}))

    async def _model_reply(self, call: _ModelCall) -> Any:
        """The agent call. An empty Gemma reply is drawn again as is: a note about it only confuses the model."""
        response = await call.handler(call.agent_request())
        for _ in range(_EMPTY_REPLY_REDRAWS):
            reply = response.result[0] if getattr(response, 'result', None) else None
            if not isinstance(reply, AIMessage) or not _is_empty_gemma_reply(reply) or output_was_truncated(reply):
                break
            if call.session.abort_event.is_set():
                break
            logger.info('Drawing again after an empty reply')
            response = await call.handler(call.agent_request())
        return response

    async def _compact_after_overflow(self, call: _ModelCall, info: tuple[int | None, int | None], level: int) -> int:
        """Compact ``call`` harder after the server rejected its prompt: the level reached, 0 when out of options."""
        cc = call.cc
        prompt_tokens, n_ctx = info
        if prompt_tokens:
            call.est = prompt_tokens
            call.ratio = corrected_ratio(call.view, call.overhead_chars, prompt_tokens)
        # No numbers: the server took less than this estimate, whatever Settings say.
        learned = n_ctx or (call.est if call.est < call.window else 0)
        if learned:
            cc['window'], cc['window_for'] = learned, _window_key(call.connection)
        call.est = max(call.est, call.window)
        logger.info('Prompt overflow (level %d): est=%d window=%d', level, call.est, call.window)
        for next_level in range(level + 1, _OVERFLOW_LEVELS + 1):
            if await self._compact(call, level=next_level):
                return next_level
        return 0

    async def _compact(self, call: _ModelCall, *, level: int = 0) -> bool:
        """Run one event on ``call``: new cut and elisions, notes, block. False when it would gain nothing."""
        request, session, cc = call.request, call.session, call.cc
        window, ratio = call.window, call.ratio
        messages = call.raw_messages
        digest, _ = build_digest(messages, session.prompt_tree_changes, digest_cap_chars(window))
        # Per request: a new one going over old files again is new work. FACTS keep the whole thread's coverage.
        _, progress = build_digest(_current_turn(messages), (), digest_cap_chars(window))
        notes_chars = max(len(str(cc.get('notes') or '')), notes_allowance_chars(window))
        kept = kept_messages(request.messages, cc, call.request_cap)
        old_cut = cc.get('cut_id')
        factor = _OVERFLOW_TAIL_FACTOR if level >= _OVERFLOW_LEVELS else 1.0

        def plan(pin: str) -> tuple[Budget, str | None]:
            budget = call.budget(len(pin), notes_chars, len(digest))
            return budget, choose_cut(kept, budget.tail * factor, ratio) or old_cut

        budget, cut_id = plan('')
        pin = pinned_request(request.messages, cut_id, call.request_cap)
        if pin:
            # It takes room from the tail only when the cut removes it: the cut can only move later now.
            budget, cut_id = plan(pin)
        tail = tail_from(kept, cut_id)
        tail_ids = {message.id for message in tail}
        already = [message_id for message_id in cc.get('elided_ids') or () if message_id in tail_ids]
        fresh = choose_elisions(tail, budget.tail * factor, ratio, already, call.request_cap)
        if level >= _OVERFLOW_LEVELS:
            results = sum(isinstance(message, ToolMessage) for message in tail)
            tool_cap = tool_output_cap_chars(window, results, call.overhead_chars / ratio)
            fresh += overflow_elisions(tail, [*already, *fresh], call.request_cap, tool_cap)
        moved = cut_id is not None and cut_id != (old_cut or (kept[0].id if kept else None))
        if not moved and not fresh:
            cc.pop('force', None)
            cc['next_soft'] = call.est + int(SOFT_EVENT_GAP_RATIO * window)
            return False

        before = call.est
        started = time.monotonic()
        status_id = f'compact-{next(_status_ids)}'
        detail = ''
        _emit_status(session, status_id, detail, 'running')
        try:
            next_cc = {
                **cc,
                'cut_id': cut_id,
                'elided_ids': [*already, *fresh],
                'floor_id': messages[-1].id,
                'progress': progress,
            }
            next_cc.pop('force', None)
            notes = await self._fresh_notes(call, next_cc, budget, digest, pin, level)
            next_cc['notes'] = notes
            futile = int(cc.get('futile') or 0)
            if not call.progress_checked:
                # A retry of this same model call had no chance to make progress.
                call.progress_checked = True
                futile = futile + 1 if cc.get('progress') == progress else 0
            next_cc['futile'] = futile
            hint = ''
            if futile:
                kept_now = kept_messages(request.messages, next_cc, call.request_cap)
                results = [message for message in kept_now if isinstance(message, ToolMessage)]
                hint = futile_hint(sum(message_chars(message) for message in results))
            next_cc['block'] = block_text(digest, notes, pin, hint)
            next_cc['hint'] = hint
            view = render_view(request.messages, next_cc, call.request_cap)
            after = call.tokens_of(view)
            next_cc['next_soft'] = after + int(SOFT_EVENT_GAP_RATIO * window)
            detail = f'{_thousands(before)} → {_thousands(after)} tokens'
        finally:
            # Stopped mid-event: nothing was compacted. The stopped turn settles the running row as stopped.
            if detail or not session.abort_event.is_set():
                _emit_status(
                    session,
                    status_id,
                    detail,
                    'complete',
                    duration_ms=round((time.monotonic() - started) * 1000),
                )
        cc.clear()
        cc.update(next_cc)
        call.view, call.est = view, after
        session.activated_context_packs -= packs_out_of_view(session.activated_context_packs, view)
        dropped = kept[: len(kept) - len(tail)]
        tool_messages = sum(isinstance(message, ToolMessage) for message in dropped) + sum(
            isinstance(message, ToolMessage) and message.id in fresh for message in tail
        )
        rounds = sum(isinstance(message, AIMessage) and bool(message.tool_calls) for message in dropped)
        _emit_compressed(session, before, after, tool_messages, rounds)
        logger.info(
            'Context compacted: %d -> %d tokens (window %d, level %d, %d messages dropped, %d elided, futile %d)',
            before,
            after,
            window,
            level,
            len(dropped),
            len(fresh),
            futile,
        )
        return True

    async def _fresh_notes(
        self,
        call: _ModelCall,
        next_cc: dict[str, Any],
        budget: Budget,
        digest: str,
        pin: str,
        level: int,
    ) -> str:
        """The notes for the new block: fresh from the model when due and they fit, else the old ones.

        On the current view the call costs no prompt decode, so that comes first when there is room; on the
        cut view it pays for its new prefix. A failure falls back to the old notes plus the digest: a
        template that refuses a Human message after a tool result lands here and the agent call still goes out.
        An empty Gemma reply is drawn again, as in :meth:`_model_reply`.
        """
        session = call.session
        old = str(call.cc.get('notes') or '')
        if not budget.has_room_for_notes:
            if not self._warned_small_window:
                self._warned_small_window = True
                logger.warning('Context window %d is too small for compaction notes; digest only', budget.window)
            return old
        messages = call.raw_messages
        calls = sum(isinstance(message, AIMessage) for message in messages)
        last_call = call.cc.get('notes_call')
        if level >= _OVERFLOW_LEVELS or (last_call is not None and calls - int(last_call) < NOTES_EVERY_CALLS):
            return old
        prompt = summary_prompt(_last_reasoning(messages), call.window)
        needed = notes_output_tokens(call.window) + len(prompt) / call.ratio
        base = call.view
        if call.est + needed >= call.window:
            cut_cc = {**next_cc, 'block': block_text(digest, old, pin)}
            base = render_view(call.request.messages, cut_cc, call.request_cap)
            if call.tokens_of(base) + needed >= call.window:
                return old
        if session.abort_event.is_set():
            raise _StoppedDuringCompaction()
        next_cc['notes_call'] = calls
        notes_request = continuation_request(call.request, base, prompt, call.provider, call.window)
        session.compaction_notes_call_open = True
        try:
            for _ in range(_EMPTY_REPLY_REDRAWS + 1):
                message = await internal_call(call.handler, notes_request)
                log_llm_call_stats(message, context='context_compaction')
                if session.abort_event.is_set() or not _is_empty_gemma_reply(message) or output_was_truncated(message):
                    break
                logger.info('Drawing the notes again after an empty reply')
        except Exception:
            if session.abort_event.is_set():
                raise
            logger.warning('Compaction notes call failed; keeping the earlier notes', exc_info=True)
            return old
        finally:
            session.compaction_notes_call_open = False
        if session.abort_event.is_set():
            raise _StoppedDuringCompaction()
        notes = accepted_notes(message, call.window)
        if not notes:
            logger.warning(
                'Compaction notes were unusable; keeping the earlier notes: content=%.300r reasoning=%.300r',
                stringify_content(message.content),
                reasoning_sidecar_text(message),
            )
        return notes or old

    def _futile_stop(self, call: _ModelCall) -> ExtendedModelResponse:
        """End the turn with an explanation instead of another model call: events keep finding no progress."""
        logger.warning('Compaction made no progress %d times in a row; ending the turn', _FUTILE_STOP)
        call.session.harness_final_text = _FUTILE_STOP_TEXT
        call.cc['futile'] = 0
        return ExtendedModelResponse(
            model_response=ModelResponse(result=[AIMessage(content=_FUTILE_STOP_TEXT)]),
            command=Command(update={'context_compaction': call.cc}),
        )

    @hook_config(can_jump_to=['end'])
    @override
    async def aafter_model(self, state: Any, runtime: Runtime[ContextT]) -> dict[str, Any] | None:
        """End the turn on a truncated reply: its tool arguments are cut off, and later hooks could promote calls from its text.

        Same id: this replaces the message. It does not raise, a failed turn would delete the thread. An empty
        Gemma reply (after its redraws) ends the turn the same way: it would otherwise end on nothing.
        """
        del runtime  # API contract; unused
        msgs = state.get('messages') or []
        last = msgs[-1] if msgs else None
        if not isinstance(last, AIMessage):
            return None
        cut_off = output_was_truncated(last)
        if not cut_off and not _is_empty_gemma_reply(last):
            return None
        kept_kwargs = {
            key: value
            for key, value in (last.additional_kwargs or {}).items()
            if key not in ('tool_calls', 'function_call', 'reasoning_details')
        }
        logger.warning('Discarded a reply %s; ending the turn', 'cut off at the output limit' if cut_off else 'with no content')
        stop_text = _truncated_stop_text(last) if cut_off else _EMPTY_REPLY_STOP_TEXT
        session = _current_session()
        if session is not None:
            session.harness_final_text = stop_text
        update: dict[str, Any] = {
            'messages': [
                last.model_copy(
                    update={'tool_calls': [], 'invalid_tool_calls': [], 'additional_kwargs': kept_kwargs, 'content': stop_text}
                )
            ],
            'jump_to': 'end',
        }
        usage = last.usage_metadata or {}
        used = int(usage.get('input_tokens') or 0) + int(usage.get('output_tokens') or 0)
        saved = state.get('context_compaction') or {}
        if cut_off and used >= _TRUNCATED_FORCE_RATIO * _thread_window(saved, _active_connection()):
            update['context_compaction'] = {**saved, 'force': True}
        return update

    @override
    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        state = request.state if isinstance(request.state, dict) else {}
        cc = state.get('context_compaction') or {}
        messages = state.get('messages') or []
        call = request.tool_call
        name = str(call.get('name') or '')
        if runtime_config.context_compression.enabled and (cc.get('cut_id') or cc.get('elided_ids')):
            resolved, exists = _resolved_edit(call)
            refusal = stale_edit_refusal(resolved, messages, cc, file_exists=exists)
            if refusal is not None:
                return ToolMessage(content=refusal, tool_call_id=str(call.get('id') or ''), name=name, status='error')
        result = await handler(request)
        overhead_tokens = (self._overhead_chars or 0) / CHARS_PER_TOKEN
        cap = tool_output_cap_chars(_thread_window(cc, _active_connection()), _calls_in_step(messages), overhead_tokens)
        if cc.get('futile'):
            cap //= 2
        return _capped_result(result, name, cap)


__all__ = ['COMPACT_PILL_LABEL', 'ContextCompactionMiddleware']
