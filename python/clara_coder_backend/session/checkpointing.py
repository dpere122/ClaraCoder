"""LangGraph AsyncSqliteSaver lifecycle and outer-agent thread_id helpers.

Electron sets ``CLARA_CHECKPOINT_DB`` to a file under userData (see ``server.ts``).
Without it, a tempfile under the system temp directory is used (durability only for
that path; intended for dev/tests without the desktop shell).

Each settled outer ``single`` thread has a sync row (:data:`SYNC_TABLE`): the history it
covers, as a user-turn count and a digest of the last user message. ``/load`` keeps a thread
whose row matches the loaded history, so a reopened conversation continues with its tool
calls and results instead of a text-only rebuild. Threads keep only their latest checkpoint
(resume needs nothing older); startup prunes the rest and reclaims the space once.
"""

from __future__ import annotations

from clara_coder_backend.config import env_clara

import asyncio
import hashlib
import logging
import os
import sqlite3
import tempfile
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

import aiosqlite
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

if TYPE_CHECKING:
    pass

logger = logging.getLogger('clara.checkpointing')

_checkpointer: AsyncSqliteSaver | None = None
_conn: aiosqlite.Connection | None = None

SYNC_TABLE = 'clara_outer_thread_sync'
#: Startup VACUUM only when at least this share of the file is free pages (and over the floor).
_VACUUM_FREE_RATIO = 0.25
_VACUUM_FREE_BYTES_FLOOR = 64 * 1024 * 1024


def default_checkpoint_db_path() -> str:
    raw = env_clara('CLARA_CHECKPOINT_DB', '').strip()
    if raw:
        return raw
    return str(Path(tempfile.gettempdir()) / 'nemo-langgraph-checkpoints.sqlite')


def outer_agent_thread_id(
    session_id: str,
    thread_kind: str,
    *,
    apply_mode: bool,
) -> str:
    """Stable per-conversation thread id.

    ``apply_mode`` keeps read vs editor tool-graph shapes separate.
    """
    mode = 'apply' if apply_mode else 'read'
    return f'{session_id}:{thread_kind}:{mode}'


async def init_graph_checkpointing() -> None:
    """Open Sqlite, construct :class:`AsyncSqliteSaver`, run ``setup()`` (idempotent)."""
    global _checkpointer, _conn
    if _checkpointer is not None:
        return
    path = default_checkpoint_db_path()
    parent = Path(path).parent
    if str(parent) not in ('', '.'):
        parent.mkdir(parents=True, exist_ok=True)
    _conn = await aiosqlite.connect(path)
    _checkpointer = AsyncSqliteSaver(_conn)
    await _checkpointer.setup()
    await _conn.execute(
        f'CREATE TABLE IF NOT EXISTS {SYNC_TABLE} ('
        'thread_id TEXT PRIMARY KEY, user_turns INTEGER NOT NULL, last_user_digest TEXT NOT NULL,'
        ' context_tokens INTEGER)'
    )
    async with _conn.execute(f'PRAGMA table_info({SYNC_TABLE})') as cur:
        columns = {row[1] for row in await cur.fetchall()}
    if 'context_tokens' not in columns:
        await _conn.execute(f'ALTER TABLE {SYNC_TABLE} ADD COLUMN context_tokens INTEGER')
    await _conn.commit()


async def compact_checkpoint_db() -> None:
    """Drop every thread's older checkpoints, then VACUUM when that freed a large share of the file.

    Run once at startup, before any turn: older checkpoints are never read (turns, compaction and
    interrupted-call repairs read the latest), and the file grew without bound before pruning
    existed. The VACUUM holds the connection while it runs.
    """
    if _conn is None:
        return
    started = time.monotonic()
    cur = await _conn.execute(
        'DELETE FROM checkpoints WHERE checkpoint_id NOT IN ('
        ' SELECT MAX(c2.checkpoint_id) FROM checkpoints c2'
        ' WHERE c2.thread_id = checkpoints.thread_id AND c2.checkpoint_ns = checkpoints.checkpoint_ns)'
    )
    pruned = cur.rowcount
    await _conn.execute(
        'DELETE FROM writes WHERE NOT EXISTS ('
        ' SELECT 1 FROM checkpoints c WHERE c.thread_id = writes.thread_id'
        ' AND c.checkpoint_ns = writes.checkpoint_ns AND c.checkpoint_id = writes.checkpoint_id)'
    )
    await _conn.commit()
    page_size = await _pragma_int('page_size')
    free_bytes = await _pragma_int('freelist_count') * page_size
    total_bytes = await _pragma_int('page_count') * page_size
    vacuumed = False
    if free_bytes >= _VACUUM_FREE_BYTES_FLOOR and total_bytes and free_bytes / total_bytes >= _VACUUM_FREE_RATIO:
        vacuumed = await _vacuum()
    if pruned or vacuumed:
        logger.info(
            'checkpoint db: pruned %d old checkpoint(s), vacuum=%s (freed %.0f MB) in %.1fs',
            pruned,
            vacuumed,
            free_bytes / (1024 * 1024) if vacuumed else 0,
            time.monotonic() - started,
        )


async def _vacuum() -> bool:
    """VACUUM on the shared connection, retrying while another request's write is still open."""
    assert _conn is not None
    for attempt in range(5):
        if _conn.in_transaction:
            await _conn.commit()
        try:
            await _conn.execute('VACUUM')
            return True
        except sqlite3.OperationalError as exc:
            if 'within a transaction' not in str(exc):
                raise
            await asyncio.sleep(0.5 * (attempt + 1))
    logger.info('checkpoint db: VACUUM skipped (connection stayed busy); next startup retries')
    return False


async def _pragma_int(name: str) -> int:
    assert _conn is not None
    async with _conn.execute(f'PRAGMA {name}') as cur:
        row = await cur.fetchone()
    return int(row[0]) if row else 0


async def shutdown_graph_checkpointing() -> None:
    """Close the Sqlite connection (FastAPI shutdown)."""
    global _checkpointer, _conn
    if _conn is not None:
        await _conn.close()
    _conn = None
    _checkpointer = None


def get_graph_checkpointer() -> AsyncSqliteSaver:
    if _checkpointer is None:
        raise RuntimeError(
            'Graph checkpointing not initialized; ensure FastAPI lifespan or tests call init_graph_checkpointing()'
        )
    return _checkpointer


def reset_graph_checkpointing_for_tests() -> None:
    """Clear module globals after tests that closed the connection (best-effort)."""
    global _checkpointer, _conn
    _conn = None
    _checkpointer = None


# Legacy thread kind ``moe`` (old outer graph id) is still cleared alongside ``single``.
OUTER_AGENT_THREAD_KINDS: tuple[str, ...] = ('single', 'moe', 'plan', 'plan_exec')


def history_fingerprint(history: list[dict[str, Any]]) -> tuple[int, str]:
    """``(user turns, digest of the last user message's text)`` of a session history.

    The same for Python's own history and one ``/load`` rebuilt from Electron SQLite, which keep
    the same user rows. A turn the two record differently (sub-agent report turns) only costs a
    text-only rebuild.
    """
    from clara_coder_backend.llm.messages import stringify_content

    users = [item for item in history if item.get('role') == 'user']
    if not users:
        return 0, ''
    text = stringify_content(users[-1].get('content', '')).strip()
    return len(users), hashlib.sha256(text.encode('utf-8')).hexdigest()


async def settle_outer_thread(
    session_id: str,
    *,
    apply_mode: bool,
    history: list[dict[str, Any]],
    freed_tokens: int = 0,
) -> None:
    """A turn on this ``single`` thread finished and its history row is committed.

    Records what the thread covers (for ``/load``), drops its older checkpoints, and deletes the
    other Editor mode's thread: it no longer has this turn, so its next turn rebuilds from history.
    The record also keeps the context meter's reading: the last model call's prompt tokens, less
    what post-turn compaction freed (``freed_tokens``), as the renderer computes it.
    """
    if _checkpointer is None or _conn is None:
        return
    tid = outer_agent_thread_id(session_id, 'single', apply_mode=apply_mode)
    user_turns, digest = history_fingerprint(history)
    input_tokens = await _last_prompt_tokens(tid)
    context_tokens = max(1, input_tokens - max(0, freed_tokens)) if input_tokens > 0 else None
    await _conn.execute(
        f'INSERT OR REPLACE INTO {SYNC_TABLE} (thread_id, user_turns, last_user_digest, context_tokens)'
        ' VALUES (?, ?, ?, ?)',
        (tid, user_turns, digest, context_tokens),
    )
    await _prune_thread(tid)
    await _conn.commit()
    await delete_outer_thread(session_id, 'single', apply_mode=not apply_mode)


async def _last_prompt_tokens(thread_id: str) -> int:
    """``input_tokens`` of the thread's last AI message with usage metadata (0 when none)."""
    assert _checkpointer is not None
    tup = await _checkpointer.aget_tuple({'configurable': {'thread_id': thread_id}})
    if tup is None:
        return 0
    messages = (tup.checkpoint.get('channel_values') or {}).get('messages') or []
    for msg in reversed(messages):
        usage = getattr(msg, 'usage_metadata', None)
        if isinstance(usage, dict) and isinstance(usage.get('input_tokens'), int):
            return int(usage['input_tokens'])
    return 0


async def _prune_thread(thread_id: str) -> None:
    """Keep only the latest checkpoint (and its pending writes) in each namespace of a thread."""
    assert _conn is not None
    await _conn.execute(
        'DELETE FROM checkpoints WHERE thread_id = ? AND checkpoint_id NOT IN ('
        ' SELECT MAX(c2.checkpoint_id) FROM checkpoints c2'
        ' WHERE c2.thread_id = checkpoints.thread_id AND c2.checkpoint_ns = checkpoints.checkpoint_ns)',
        (thread_id,),
    )
    await _conn.execute(
        'DELETE FROM writes WHERE thread_id = ? AND NOT EXISTS ('
        ' SELECT 1 FROM checkpoints c WHERE c.thread_id = writes.thread_id'
        ' AND c.checkpoint_ns = writes.checkpoint_ns AND c.checkpoint_id = writes.checkpoint_id)',
        (thread_id,),
    )


async def _matching_thread_context(thread_id: str, history: list[dict[str, Any]]) -> int | None:
    """The thread's recorded context tokens (0 when unknown) if it covers ``history``, else None."""
    if _conn is None:
        return None
    async with _conn.execute(
        f'SELECT user_turns, last_user_digest, context_tokens FROM {SYNC_TABLE} WHERE thread_id = ?',
        (thread_id,),
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        return None
    user_turns, digest = history_fingerprint(history)
    if user_turns == 0 or (int(row[0]), str(row[1])) != (user_turns, digest):
        return None
    return int(row[2] or 0)


async def _delete_thread(thread_id: str) -> None:
    assert _checkpointer is not None
    await _checkpointer.adelete_thread(thread_id)
    if _conn is not None:
        await _conn.execute(f'DELETE FROM {SYNC_TABLE} WHERE thread_id = ?', (thread_id,))
        await _conn.commit()


async def delete_outer_threads_for_session(
    session_id: str,
    thread_kind: str | None = None,
    *,
    keep_matching: list[dict[str, Any]] | None = None,
) -> int | None:
    """Remove LangGraph checkpoints for outer threads (conversation reset or resync).

    Called from ``/clear``, ``/dispose``, and ``/load`` so Electron SQLite history is the
    source of truth for the next model turn.

    ``keep_matching`` (``/load`` of a reopened conversation): a ``single`` thread whose sync row
    matches this history is kept, so the next turn continues from its checkpoint. Returns its
    recorded context tokens (0 when unknown) when one was kept, else None.

    When ``thread_kind`` is None, clears every known outer graph kind (see ``OUTER_AGENT_THREAD_KINDS``).
    Deletes current thread-id shapes (apply × orchestration) and legacy ids without ``:orch*``.
    """
    if _checkpointer is None:
        return None
    kept: int | None = None
    kinds: tuple[str, ...] = (thread_kind,) if thread_kind else OUTER_AGENT_THREAD_KINDS
    for kind in kinds:
        for apply_mode in (True, False):
            tid = outer_agent_thread_id(session_id, kind, apply_mode=apply_mode)
            if keep_matching is not None and kind == 'single':
                context = await _matching_thread_context(tid, keep_matching)
                if context is not None:
                    kept = context
                    continue
            await delete_outer_thread(session_id, kind, apply_mode=apply_mode)
    return kept


async def delete_outer_thread(session_id: str, thread_kind: str, *, apply_mode: bool) -> None:
    """Remove checkpoints for one outer thread (e.g. failed/aborted turn)."""
    if _checkpointer is None:
        return
    tid = outer_agent_thread_id(
        session_id,
        thread_kind,
        apply_mode=apply_mode,
    )
    await _delete_thread(tid)
    mode = 'apply' if apply_mode else 'read'
    for orch in ('0', '1'):
        legacy_orch = f'{session_id}:{thread_kind}:{mode}:orch{orch}'
        if legacy_orch != tid:
            await _checkpointer.adelete_thread(legacy_orch)
