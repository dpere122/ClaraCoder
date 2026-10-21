"""Detached, serialized chat turns: one turn per session at a time, owned by no HTTP request.

``POST /chat/stream`` hands :func:`serve_turn` a factory for the turn's SSE generator. The turn runs in
its own task (``drive``) and its lines reach the response through a queue, so:

- A client disconnect cancels only the relay, never the turn. Starlette cancels the whole response
  task on disconnect, and every await in its cleanup is cancelled again, so a turn run inside the
  response would skip its post-stream bookkeeping. The relay's synchronous :meth:`TurnRelay.detach`
  just flags the turn as client-gone and aborts it; the turn then winds down on its own.
- Turns of one session never overlap. A new turn preempts the running one (its generation only:
  sub-agents belong to the conversation and keep running) and waits for it to finish. A turn that a
  newer one replaced before it started is recorded as superseded instead of run. A turn started with
  ``preempt=False`` (Electron continuing with sub-agent results) queues behind a running one instead.
- ``file_journal`` rows produced after the client left are kept (``carry_over``) and sent first on the
  session's next stream, so that turn's files can still be reviewed and reset.

The registry is keyed by session id and is deliberately not stored on
:class:`~clara_coder_backend.domain.SessionState`: ``/clear`` replaces that object mid-turn.
``/clear``, ``/dispose`` and ``/load`` call :func:`stop_session_turn` first; app shutdown calls
:func:`stop_all_turns`. :func:`~clara_coder_backend.composer.stream_agent_reply` itself stays lock-free
(sub-agents and tests call it directly).
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Callable
from contextlib import aclosing
from dataclasses import dataclass, field

from clara_coder_backend.lang_agent.streaming import sse_line, status_event

logger = logging.getLogger('clara.session.turns')

#: How long ``/clear`` / ``/dispose`` / ``/load`` wait for a stopped turn to wind down.
TURN_STOP_TIMEOUT_SEC = 15.0

_END = object()


@dataclass(eq=False)
class TurnHandle:
    """One ``/chat/stream`` request's turn and the queue its relay reads."""

    session_id: str
    seq: int
    queue: asyncio.Queue = field(default_factory=asyncio.Queue)
    task: asyncio.Task | None = None
    #: The relay ended before the turn did (client disconnected); the turn was aborted.
    client_gone: bool = False


@dataclass
class SessionTurns:
    """Per-session turn serialization (see module docstring)."""

    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    #: Sequence number of the newest turn; a waiting turn with an older number is superseded.
    seq: int = 0
    #: The turn holding ``lock`` and streaming, if any.
    active: TurnHandle | None = None
    #: Turns not finished yet (running or waiting); strong references to their tasks.
    pending: set[TurnHandle] = field(default_factory=set)
    #: ``file_journal`` SSE lines produced after their client left, sent first on the next stream.
    carry_over: list[str] = field(default_factory=list)


_TURNS: dict[str, SessionTurns] = {}
#: Fire-and-forget abort tasks scheduled from the relay's synchronous ``finally``.
_BACKGROUND: set[asyncio.Task] = set()


def _turns_for(session_id: str) -> SessionTurns:
    return _TURNS.setdefault(session_id, SessionTurns())


def _is_file_journal_line(line: str) -> bool:
    if not line.startswith('data: {'):
        return False
    try:
        payload = json.loads(line[len('data: ') :])
    except ValueError:
        return False
    return isinstance(payload, dict) and payload.get('type') == 'file_journal'


async def _abort_session_turn(session_id: str) -> None:
    """Stop the session's live generation without waiting for the turn to end (sub-agents keep running)."""
    from clara_coder_backend.llm.http_transport import abort_in_flight_generation
    from clara_coder_backend.session.state import sessions

    sess = sessions.get(session_id)
    if sess is not None:
        await abort_in_flight_generation(sess, session_id)


def _abort_soon(session_id: str) -> None:
    """Synchronous: flag the abort now, close the HTTP generation in a task."""
    from clara_coder_backend.session.state import sessions

    sess = sessions.get(session_id)
    if sess is not None:
        sess.abort_event.set()
        pause = sess.agent_pause_event
        if pause is not None:
            pause.set()
    try:
        task = asyncio.get_running_loop().create_task(_abort_session_turn(session_id))
    except RuntimeError:
        return
    _BACKGROUND.add(task)
    task.add_done_callback(_BACKGROUND.discard)


async def _drive(
    turns: SessionTurns,
    handle: TurnHandle,
    make_gen: Callable[[], AsyncIterator[str]],
    on_superseded: Callable[[], None] | None,
    preempt: bool,
    on_abandoned: Callable[[], None] | None = None,
) -> None:
    sid = handle.session_id
    out = handle.queue
    try:
        if turns.lock.locked() and preempt:
            # A turn is still running: stop it (new input interrupts) and queue behind it.
            await _abort_session_turn(sid)
        async with turns.lock:
            if handle.client_gone or handle.seq != turns.seq:
                logger.info('Turn superseded before it started session=%s seq=%d', sid, handle.seq)
                callbacks = [on_superseded]
                if handle.seq == turns.seq:
                    # Only its client left: no newer turn (or stop) took its place.
                    callbacks.append(on_abandoned)
                for callback in callbacks:
                    if callback is None:
                        continue
                    try:
                        callback()
                    except Exception:
                        logger.warning('recording a superseded turn failed session=%s', sid, exc_info=True)
                out.put_nowait('data: [DONE]\n\n')
                return
            turns.active = handle
            carried, turns.carry_over = turns.carry_over, []
            for line in carried:
                out.put_nowait(line)
            try:
                async with aclosing(make_gen()) as lines:
                    async for line in lines:
                        if handle.client_gone:
                            if _is_file_journal_line(line):
                                turns.carry_over.append(line)
                            continue
                        out.put_nowait(line)
            except Exception as exc:
                logger.exception('Chat turn failed session=%s', sid)
                out.put_nowait(
                    sse_line(
                        status_event(
                            'fatal',
                            'LangChain request failed',
                            detail=f'{type(exc).__name__}: {exc}',
                            state='error',
                        )
                    )
                )
                out.put_nowait('data: [DONE]\n\n')
            finally:
                if turns.active is handle:
                    turns.active = None
    finally:
        turns.pending.discard(handle)
        out.put_nowait(_END)


def _client_left(turns: SessionTurns, handle: TurnHandle) -> None:
    """The response ended before the turn did: flag it and abort it if it is the one running.

    Synchronous on purpose: on disconnect every await in the response's cleanup is cancelled again.
    A turn still waiting for the lock just skips itself when it gets it.
    """
    if handle.client_gone or handle.task is None or handle.task.done():
        return
    handle.client_gone = True
    if turns.active is handle:
        _abort_soon(handle.session_id)


class TurnRelay:
    """What the HTTP response streams: the turn's lines until it ends.

    Starlette never closes a response's body iterator, so the response calls :meth:`detach` when it
    is over (finished, failed or disconnected); closing the iterator does the same.
    """

    def __init__(self, turns: SessionTurns, handle: TurnHandle) -> None:
        self._turns = turns
        self._handle = handle
        self._ended = False

    def __aiter__(self) -> TurnRelay:
        return self

    async def __anext__(self) -> str:
        if self._ended:
            raise StopAsyncIteration
        try:
            line = await self._handle.queue.get()
        except BaseException:
            # Cancelled while waiting (the response task on disconnect).
            self.detach()
            raise
        if line is _END:
            self._ended = True
            raise StopAsyncIteration
        return line

    async def aclose(self) -> None:
        self.detach()

    def detach(self) -> None:
        """The response is over; a turn still running loses its client (synchronous, idempotent)."""
        if not self._ended:
            _client_left(self._turns, self._handle)


def serve_turn(
    session_id: str,
    make_gen: Callable[[], AsyncIterator[str]],
    *,
    on_superseded: Callable[[], None] | None = None,
    preempt: bool = True,
    on_abandoned: Callable[[], None] | None = None,
) -> TurnRelay:
    """Start one turn for ``session_id`` in a detached task; return the SSE relay for the response.

    ``make_gen`` builds the turn's generator once the session's previous turn has ended.
    ``on_superseded`` runs instead when a newer turn (or a stop) replaced this one before it started,
    or its client left first; ``on_abandoned`` runs after it in that last case only (nothing replaced it).
    ``preempt=False`` waits for a running turn instead of interrupting it.
    Must be called from a running event loop (the route handler).
    """
    turns = _turns_for(session_id)
    turns.seq += 1
    handle = TurnHandle(session_id=session_id, seq=turns.seq)
    turns.pending.add(handle)
    handle.task = asyncio.get_running_loop().create_task(
        _drive(turns, handle, make_gen, on_superseded, preempt, on_abandoned)
    )
    return TurnRelay(turns, handle)


def session_turn_active(session_id: str) -> bool:
    """True while a turn for ``session_id`` is running or waiting to run."""
    turns = _TURNS.get(session_id)
    return bool(turns and turns.pending)


def session_turn_pending(session_id: str, *, exclude_current: bool = False) -> bool:
    """True while a turn for ``session_id`` is running or waiting; ``exclude_current`` skips the caller's.

    A turn's own cleanup (inside its composer) asks whether *another* turn will follow.
    """
    turns = _TURNS.get(session_id)
    if not turns:
        return False
    current = asyncio.current_task() if exclude_current else None
    return any(h.task is not None and h.task is not current and not h.task.done() for h in turns.pending)


async def stop_session_turn(session_id: str, *, timeout: float = TURN_STOP_TIMEOUT_SEC) -> None:
    """Abort the session's running turn, drop the waiting ones, and wait for them to finish.

    Waiting turns are superseded (recorded, not run). A turn that does not wind down within
    ``timeout`` is cancelled so a reset session never gets checkpoints from an old turn.
    """
    turns = _TURNS.get(session_id)
    if turns is None:
        return
    turns.seq += 1
    turns.carry_over.clear()
    tasks = {h.task for h in turns.pending if h.task is not None and not h.task.done()}
    if not tasks:
        return
    if turns.active is not None:
        await _abort_session_turn(session_id)
    _done, still = await asyncio.wait(tasks, timeout=timeout)
    for task in still:
        logger.warning('Turn did not stop within %.0fs; cancelling session=%s', timeout, session_id)
        task.cancel()
    if still:
        await asyncio.wait(still, timeout=2.0)


def forget_session_turns(session_id: str) -> None:
    """Drop a disposed session's registry entry once it has no turn left."""
    turns = _TURNS.get(session_id)
    if turns is not None and not turns.pending:
        _TURNS.pop(session_id, None)


async def stop_all_turns(*, timeout: float = TURN_STOP_TIMEOUT_SEC) -> None:
    """App shutdown: stop every session's turns (before checkpointing shuts down)."""
    sids = list(_TURNS)
    if sids:
        await asyncio.gather(*(stop_session_turn(sid, timeout=timeout) for sid in sids), return_exceptions=True)
    _TURNS.clear()


def reset_turns_for_tests() -> None:
    """Forget every registry entry (asyncio locks are bound to the loop that first waited on them)."""
    _TURNS.clear()
    _BACKGROUND.clear()


__all__ = [
    'TURN_STOP_TIMEOUT_SEC',
    'TurnRelay',
    'forget_session_turns',
    'reset_turns_for_tests',
    'serve_turn',
    'session_turn_active',
    'session_turn_pending',
    'stop_all_turns',
    'stop_session_turn',
]
