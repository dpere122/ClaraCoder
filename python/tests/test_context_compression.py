"""Tests for LangGraph checkpoint context compaction."""

from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from nemo_backend.context_compression import (
    compact_checkpoint_messages,
    compact_tool_message_body,
    estimate_messages_tokens,
)
from nemo_backend.domain import RuntimeContextCompressionConfig


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


def _budget_over_trigger(messages: list, cfg: RuntimeContextCompressionConfig) -> int:
    tokens = estimate_messages_tokens(messages)
    # Pick a budget low enough that token estimate exceeds trigger_ratio * budget.
    return max(512, int(tokens / cfg.trigger_ratio) - 16)


def test_compact_read_tool_message_uses_placeholder() -> None:
    body = 'File: src/foo.ts\n' + ('x' * 5000)
    out = compact_tool_message_body('read_workspace_file', body, 400)
    assert out.startswith('[compacted] read_workspace_file: src/foo.ts')
    assert '5017 chars' in out


def test_no_compaction_when_under_budget() -> None:
    long_body = 'y' * 3000
    messages = [
        ToolMessage(content=long_body, tool_call_id='t1', name='read_workspace_file'),
        HumanMessage(content='follow up'),
    ]
    cfg = _cfg(protect_tail_messages=0)
    compacted, stats = compact_checkpoint_messages(messages, cfg=cfg, budget_tokens=1_000_000)
    assert not stats.changed
    assert stats.tool_messages_compacted == 0
    assert stats.tool_rounds_dropped == 0
    assert compacted is messages


def test_compact_tool_messages_respects_protected_tail() -> None:
    long_body = 'y' * 3000
    messages = [
        ToolMessage(content=long_body, tool_call_id='t1', name='read_workspace_file'),
        HumanMessage(content='follow up'),
        ToolMessage(content='z' * 3000, tool_call_id='t2', name='read_workspace_file'),
    ]
    cfg = _cfg(protect_tail_messages=1)
    budget = _budget_over_trigger(messages, cfg)
    compacted, stats = compact_checkpoint_messages(messages, cfg=cfg, budget_tokens=budget)
    assert stats.changed
    assert stats.tool_messages_compacted == 1
    assert stats.tool_rounds_dropped == 0
    assert len(compacted) == len(messages)
    assert '[compacted]' in str(compacted[0].content)
    assert 'z' * 100 in str(compacted[2].content)


def test_compact_tool_messages_is_idempotent() -> None:
    body = 'File: a.py\n' + ('line\n' * 400)
    messages = [ToolMessage(content=body, tool_call_id='t1', name='read_workspace_file')]
    cfg = _cfg(protect_tail_messages=0)
    budget = _budget_over_trigger(messages, cfg)
    first, stats1 = compact_checkpoint_messages(messages, cfg=cfg, budget_tokens=budget)
    second, stats2 = compact_checkpoint_messages(first, cfg=cfg, budget_tokens=budget)
    assert stats1.tool_messages_compacted == 1
    assert stats2.tool_messages_compacted == 0
    assert str(first[0].content) == str(second[0].content)


def test_never_drops_tool_rounds_when_over_budget() -> None:
    huge = 'q' * 8000
    messages: list = [
        AIMessage(content='', tool_calls=[{'id': 'call-1', 'name': 'read_workspace_file', 'args': {}}]),
        ToolMessage(content=huge, tool_call_id='call-1', name='read_workspace_file'),
        HumanMessage(content='latest question'),
        AIMessage(content='visible answer'),
    ]
    cfg = _cfg(protect_tail_messages=2, trigger_ratio=0.01, target_ratio=0.01)
    budget = estimate_messages_tokens(messages) // 2
    compacted, stats = compact_checkpoint_messages(messages, cfg=cfg, budget_tokens=budget)
    assert stats.changed
    assert stats.tool_rounds_dropped == 0
    assert len(compacted) == len(messages)
    assert any(isinstance(m, ToolMessage) for m in compacted)
    assert any(isinstance(m, AIMessage) and 'visible answer' in str(m.content) for m in compacted)


def test_no_compaction_for_non_tool_messages_only() -> None:
    messages: list = [
        AIMessage(content='Here is the summary you asked for.', tool_calls=[]),
        HumanMessage(content='thanks'),
    ]
    cfg = _cfg(protect_tail_messages=0, trigger_ratio=0.01, target_ratio=0.01)
    compacted, stats = compact_checkpoint_messages(messages, cfg=cfg, budget_tokens=10)
    assert not stats.changed
    assert stats.tool_messages_compacted == 0
    assert stats.tool_rounds_dropped == 0
    assert any(isinstance(m, AIMessage) and 'summary' in str(m.content) for m in compacted)
