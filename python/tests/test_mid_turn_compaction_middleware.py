"""Tests for mid-turn tool body compaction middleware."""

from __future__ import annotations

import asyncio
from unittest.mock import patch

import pytest
from langchain_core.messages import HumanMessage, ToolMessage
from langgraph.graph.message import add_messages

from clara_coder_backend.domain import RuntimeContextCompressionConfig, SessionState
from clara_coder_backend.lang_agent.context_compression import (
    compact_stale_tool_messages,
    stale_tool_message_replacements,
)
from clara_coder_backend.middleware.mid_turn_compaction_middleware import MidTurnContextCompactionMiddleware
from clara_coder_backend.session.state import sessions


def _cfg(**overrides: object) -> RuntimeContextCompressionConfig:
    base = RuntimeContextCompressionConfig(
        enabled=True,
        trigger_ratio=0.70,
        target_ratio=0.55,
        protect_tail_messages=2,
        recent_tool_body_max_chars=2000,
        old_tool_body_max_chars=400,
        system_reserve_ratio=0.25,
    )
    for key, val in overrides.items():
        setattr(base, key, val)
    return base


@pytest.fixture(autouse=True)
def _clear_sessions() -> None:
    sessions.clear()
    yield
    sessions.clear()


def test_compact_stale_runs_under_budget() -> None:
    body = 'File: src/foo.ts\n' + ('x' * 5000)
    messages = [
        ToolMessage(content=body, tool_call_id='t1', name='read_workspace_file', id='m1'),
        HumanMessage(content='follow up', id='h1'),
        ToolMessage(content='short', tool_call_id='t2', name='search_workspace', id='m2'),
    ]
    cfg = _cfg(protect_tail_messages=1)
    compacted, stats = compact_stale_tool_messages(messages, cfg=cfg)
    assert stats.ran
    assert stats.changed
    assert stats.tool_messages_compacted == 1
    assert '[compacted]' in str(compacted[0].content)
    assert compacted[0].id == 'm1'
    assert str(compacted[2].content) == 'short'


def test_stale_replacements_preserve_id_and_replace_via_add_messages() -> None:
    body = 'File: a.py\n' + ('line\n' * 400)
    messages = [
        ToolMessage(content=body, tool_call_id='t1', name='read_workspace_file', id='tool-1'),
        HumanMessage(content='hi', id='h1'),
        ToolMessage(content='z' * 50, tool_call_id='t2', name='read_workspace_file', id='tool-2'),
    ]
    cfg = _cfg(protect_tail_messages=1)
    replacements, stats = stale_tool_message_replacements(messages, cfg=cfg)
    assert stats.changed
    assert len(replacements) == 1
    assert replacements[0].id == 'tool-1'
    assert '[compacted]' in str(replacements[0].content)

    merged = add_messages(messages, replacements)
    assert len(merged) == 3
    assert merged[0].id == 'tool-1'
    assert '[compacted]' in str(merged[0].content)
    assert 'z' * 50 in str(merged[2].content)


def test_stale_replacements_skip_messages_without_id() -> None:
    body = 'File: a.py\n' + ('line\n' * 400)
    messages = [
        ToolMessage(content=body, tool_call_id='t1', name='read_workspace_file'),
        HumanMessage(content='hi'),
    ]
    cfg = _cfg(protect_tail_messages=0)
    replacements, stats = stale_tool_message_replacements(messages, cfg=cfg)
    assert replacements == []
    assert not stats.changed


@pytest.mark.asyncio
async def test_abefore_model_returns_replacements_and_enqueues_sse() -> None:
    body = 'File: src/foo.ts\n' + ('x' * 5000)
    messages = [
        ToolMessage(content=body, tool_call_id='t1', name='read_workspace_file', id='m1'),
        HumanMessage(content='follow up', id='h1'),
        ToolMessage(content='tail', tool_call_id='t2', name='search_workspace', id='m2'),
    ]
    cfg = _cfg(protect_tail_messages=1)
    sess = SessionState()
    sess.hitl_sse_queue = asyncio.Queue()
    sessions['sess-mid'] = sess

    mw = MidTurnContextCompactionMiddleware()
    with (
        patch(
            'clara_coder_backend.middleware.mid_turn_compaction_middleware.effective_compression_config',
            return_value=cfg,
        ),
        patch(
            'clara_coder_backend.middleware.mid_turn_compaction_middleware.current_session_id'
        ) as sid_ctx,
    ):
        sid_ctx.get.return_value = 'sess-mid'
        update = await mw.abefore_model({'messages': messages}, runtime=None)  # type: ignore[arg-type]

    assert update is not None
    assert 'messages' in update
    assert len(update['messages']) == 1
    assert update['messages'][0].id == 'm1'
    assert '[compacted]' in str(update['messages'][0].content)

    item = sess.hitl_sse_queue.get_nowait()
    assert item[0] == 'context_compressed'
    assert item[1]['type'] == 'context_compressed'
    assert item[1]['tool_messages_compacted'] == 1


@pytest.mark.asyncio
async def test_abefore_model_noop_when_disabled() -> None:
    body = 'File: src/foo.ts\n' + ('x' * 5000)
    messages = [
        ToolMessage(content=body, tool_call_id='t1', name='read_workspace_file', id='m1'),
        HumanMessage(content='follow up', id='h1'),
    ]
    cfg = _cfg(enabled=False, protect_tail_messages=0)
    mw = MidTurnContextCompactionMiddleware()
    with patch(
        'clara_coder_backend.middleware.mid_turn_compaction_middleware.effective_compression_config',
        return_value=cfg,
    ):
        update = await mw.abefore_model({'messages': messages}, runtime=None)  # type: ignore[arg-type]
    assert update is None
