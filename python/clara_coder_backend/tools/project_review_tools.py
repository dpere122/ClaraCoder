"""Shared subprocess streaming helpers for staging overlay (and similar) tools."""

from __future__ import annotations

import asyncio
import codecs
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field

from clara_coder_backend.runtime.python_env import _terminate_subprocess_tree
from clara_coder_backend.session.state import get_session
from clara_coder_backend.stream_tags import TOOL_PYTEST_STREAM_TAG

_DEFAULT_STREAM_TAG = TOOL_PYTEST_STREAM_TAG
_DEFAULT_STREAM_LABEL = 'Workspace Tool'
_SUBPROCESS_READ_SIZE = 65536
_MAX_CAPTURE_CHARS = 2_000_000

__all__ = [
    'RollingTextBuffer',
    '_emit_project_review_chunk',
    '_emit_project_review_tool_complete',
    '_pump_subprocess_stream',
    '_terminate_process',
]


@dataclass
class RollingTextBuffer:
    """Bounded in-memory capture; drops oldest chars once past ``max_chars``."""

    max_chars: int = _MAX_CAPTURE_CHARS
    _parts: deque[str] = field(default_factory=deque)
    _size: int = 0

    def append(self, text: str) -> None:
        if not text:
            return
        self._parts.append(text)
        self._size += len(text)
        while self._size > self.max_chars and self._parts:
            overflow = self._size - self.max_chars
            first = self._parts[0]
            if len(first) <= overflow:
                self._parts.popleft()
                self._size -= len(first)
            else:
                self._parts[0] = first[overflow:]
                self._size -= overflow

    def as_str(self) -> str:
        return ''.join(self._parts)


async def _emit_project_review_chunk(
    session_id: str,
    delta: str,
    *,
    stream_tag: str = _DEFAULT_STREAM_TAG,
    label: str = _DEFAULT_STREAM_LABEL,
) -> None:
    if not delta:
        return
    session = get_session(session_id)
    queue = session.planning_nested_events_q
    if queue is None:
        return
    await queue.put(
        (
            stream_tag,
            {
                'event': 'tool_exec_chunk',
                'data': {
                    'delta': delta,
                    'stream_tag': stream_tag,
                    'label': label,
                },
            },
        )
    )


async def _emit_project_review_tool_complete(
    session_id: str,
    *,
    stream_tag: str,
    label: str,
    exit_code: int | None,
    output_excerpt: str = '',
    outcome: str | None = None,
) -> None:
    session = get_session(session_id)
    queue = session.planning_nested_events_q
    if queue is None:
        return
    payload: dict[str, object] = {
        'stream_tag': stream_tag,
        'label': label,
        'exit_code': exit_code,
    }
    excerpt = output_excerpt.strip()
    if excerpt:
        payload['output_excerpt'] = excerpt
    if outcome in ('passed', 'failed'):
        payload['outcome'] = outcome
    await queue.put((stream_tag, {'event': 'tool_exec_complete', 'data': payload}))


async def _pump_subprocess_stream(
    stream: asyncio.StreamReader | None,
    *,
    session_id: str,
    emit_prefix: str,
    capture: RollingTextBuffer,
    stream_tag: str = _DEFAULT_STREAM_TAG,
    label: str = _DEFAULT_STREAM_LABEL,
    on_text: Callable[[str], None] | None = None,
) -> None:
    if stream is None:
        return
    # Incremental: a multi-byte UTF-8 character split across two reads must not turn into two U+FFFD.
    decoder = codecs.getincrementaldecoder('utf-8')('replace')
    while True:
        block = await stream.read(_SUBPROCESS_READ_SIZE)
        text = decoder.decode(block, not block)
        if not block and not text:
            break
        capture.append(text)
        if on_text is not None:
            on_text(text)
        rendered = f'{emit_prefix}{text}' if emit_prefix else text
        await _emit_project_review_chunk(session_id, rendered, stream_tag=stream_tag, label=label)
        if not block:
            break


async def _terminate_process(proc: asyncio.subprocess.Process) -> int | None:
    """Terminate the subprocess tree (npm/pytest often spawn children).

    Falls back to terminate/kill when ``pid`` is absent (tests use lightweight mocks).
    """
    if proc.returncode is not None:
        return proc.returncode
    pid = getattr(proc, 'pid', None)
    if isinstance(pid, int) and pid > 0:
        await _terminate_subprocess_tree(proc)
        return proc.returncode
    try:
        proc.terminate()
        await asyncio.wait_for(proc.wait(), timeout=3.0)
    except (ProcessLookupError, asyncio.TimeoutError):
        try:
            proc.kill()
            await asyncio.wait_for(proc.wait(), timeout=3.0)
        except (ProcessLookupError, asyncio.TimeoutError):
            return proc.returncode
    return proc.returncode
