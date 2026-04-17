"""LangGraph AsyncSqliteSaver lifecycle and outer-agent thread_id helpers.

Electron sets ``NEMO_CHECKPOINT_DB`` to a file under userData (see ``server.ts``).
Without it, a tempfile under the system temp directory is used (durability only for
that path; intended for dev/tests without the desktop shell).
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING

import aiosqlite
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

if TYPE_CHECKING:
    pass

_checkpointer: AsyncSqliteSaver | None = None
_conn: aiosqlite.Connection | None = None


def default_checkpoint_db_path() -> str:
    raw = os.environ.get('NEMO_CHECKPOINT_DB', '').strip()
    if raw:
        return raw
    return str(Path(tempfile.gettempdir()) / 'nemo-langgraph-checkpoints.sqlite')


def outer_agent_thread_id(session_id: str, thread_kind: str, *, apply_mode: bool) -> str:
    """Stable per-conversation thread id; ``apply_mode`` keeps tool-graph shape aligned with checkpoints."""
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


async def delete_outer_threads_for_session(session_id: str, thread_kind: str = 'single') -> None:
    """Remove LangGraph checkpoints for both apply/read outer threads (conversation reset or resync)."""
    if _checkpointer is None:
        return
    for apply_mode in (True, False):
        tid = outer_agent_thread_id(session_id, thread_kind, apply_mode=apply_mode)
        await _checkpointer.adelete_thread(tid)


async def delete_outer_thread(session_id: str, thread_kind: str, *, apply_mode: bool) -> None:
    """Remove checkpoints for one outer thread (e.g. failed/aborted turn)."""
    if _checkpointer is None:
        return
    await _checkpointer.adelete_thread(outer_agent_thread_id(session_id, thread_kind, apply_mode=apply_mode))
