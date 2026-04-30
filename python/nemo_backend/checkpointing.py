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


def outer_agent_thread_id(
    session_id: str,
    thread_kind: str,
    *,
    apply_mode: bool,
    orchestrated_mode: bool = False,
    phased_outer_coding: bool = False,
) -> str:
    """Stable per-conversation thread id.

    ``apply_mode`` keeps read vs editor tool-graph shapes separate. ``orchestrated_mode`` is included so toggling
    Settings → Tools → Orchestrated mode does not reuse LangGraph checkpoints built with a different tool list /
    system prompt (outer agent binds ``plan_and_modify`` only when orchestration is on).
    ``phased_outer_coding`` isolates the Learn→Write→Verify parent graph from the flat ``create_agent`` outer graph.
    """
    mode = 'apply' if apply_mode else 'read'
    orch = '1' if orchestrated_mode else '0'
    base = f'{session_id}:{thread_kind}:{mode}:orch{orch}'
    if phased_outer_coding:
        return f'{base}:ph1'
    return base


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


# ``moe`` kept for clearing legacy checkpoints from older builds that used a separate outer graph id.
OUTER_AGENT_THREAD_KINDS: tuple[str, ...] = ('single', 'moe')


async def delete_outer_threads_for_session(session_id: str, thread_kind: str | None = None) -> None:
    """Remove LangGraph checkpoints for outer threads (conversation reset or resync).

    When ``thread_kind`` is None, clears every known outer graph kind (``single`` plus legacy ``moe``).
    Deletes current thread-id shapes (apply × orchestration) and legacy ids without ``:orch*``.
    """
    if _checkpointer is None:
        return
    kinds: tuple[str, ...] = (thread_kind,) if thread_kind else OUTER_AGENT_THREAD_KINDS
    for kind in kinds:
        for apply_mode in (True, False):
            legacy_tid = f'{session_id}:{kind}:{"apply" if apply_mode else "read"}'
            await _checkpointer.adelete_thread(legacy_tid)
            for orchestrated_mode in (True, False):
                for phased_outer_coding in (True, False):
                    tid = outer_agent_thread_id(
                        session_id,
                        kind,
                        apply_mode=apply_mode,
                        orchestrated_mode=orchestrated_mode,
                        phased_outer_coding=phased_outer_coding,
                    )
                    await _checkpointer.adelete_thread(tid)


async def delete_outer_thread(session_id: str, thread_kind: str, *, apply_mode: bool) -> None:
    """Remove checkpoints for one outer thread (e.g. failed/aborted turn)."""
    if _checkpointer is None:
        return
    from nemo_backend.state import runtime_config

    orch = runtime_config.tools.orchestrated_mode
    phased = runtime_config.tools.outer_phased_coding_cycle
    tid = outer_agent_thread_id(
        session_id,
        thread_kind,
        apply_mode=apply_mode,
        orchestrated_mode=orch,
        phased_outer_coding=phased,
    )
    await _checkpointer.adelete_thread(tid)
    legacy_tid = f'{session_id}:{thread_kind}:{"apply" if apply_mode else "read"}'
    if legacy_tid != tid:
        await _checkpointer.adelete_thread(legacy_tid)
