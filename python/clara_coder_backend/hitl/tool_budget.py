"""Token-budget guard for bound tool schemas.

Measures the OpenAI function-schema token cost of each mode's bound tool set
and asserts it stays under :data:`TOOL_BUDGET_CAP`. Catches description bloat
before it silently inflates per-turn context.

Run the CI guard:

    python -m pytest python/tests/test_tool_budget.py -q
"""

from __future__ import annotations

import json
from typing import Any

from langchain_core.utils.function_calling import convert_to_openai_tool

from clara_coder_backend.domain import SessionState
from clara_coder_backend.hitl.tool_registry import worker_tools_and_map

#: Per-mode cap on bound tool schema tokens (cl100k_base), MCP tools excluded. Measured baselines
#: (with the sub-agent tools): read_only ~3.8k, editor ~6.1k, plan ~5.7k, editor + web + formatters ~6.5k.
#: The cap leaves room for richer per-tool detail, but a reintroduced tool family or runaway prose fails CI.
TOOL_BUDGET_CAP = 9_000


def _tool_name(tool: Any) -> str:
    return getattr(tool, 'name', None) or getattr(tool, '__name__', 'unknown')


def measure_tools(tools: list[Any]) -> dict:
    """Return per-tool and total cl100k token counts for bound tool schemas.

    Each tool is converted to its OpenAI function schema via
    ``convert_to_openai_tool``, JSON-encoded, and counted with the
    ``cl100k_base`` encoding (the encoding the bound schemas are billed under).
    """
    import tiktoken

    enc = tiktoken.get_encoding('cl100k_base')
    per_tool: list[tuple[str, int]] = []
    total = 0
    for tool in tools:
        schema = convert_to_openai_tool(tool)
        encoded = json.dumps(schema, ensure_ascii=False)
        tokens = len(enc.encode(encoded))
        per_tool.append((_tool_name(tool), tokens))
        total += tokens
    per_tool.sort(key=lambda item: item[1], reverse=True)
    return {'per_tool': per_tool, 'total': total, 'count': len(tools)}


def _mode_tool_set(mode: str, *, session: SessionState | None = None) -> list[Any]:
    sess = session or SessionState()
    # Measured as the agent-mode chat turn binds them: with the sub-agent tools (plan discovery is a
    # subset of ``read_only``, plan execution has its own guard).
    if mode == 'read_only':
        tools, _ = worker_tools_and_map(False, session=sess, include_subagent_tool=True)
        return tools
    if mode == 'editor':
        tools, _ = worker_tools_and_map(True, session=sess, include_subagent_tool=True)
        return tools
    raise ValueError(f"unknown mode {mode!r}; expected 'read_only' or 'editor'")


def measure_mode(mode: str, *, session: SessionState | None = None) -> dict:
    """Measure the bound tool schema token cost for one of the three modes."""
    return measure_tools(_mode_tool_set(mode, session=session))


def assert_under_budget(mode: str, cap: int = TOOL_BUDGET_CAP, *, session: SessionState | None = None) -> None:
    """Assert ``measure_mode(mode)['total'] <= cap``; raise with a per-tool cost table on failure."""
    result = measure_mode(mode, session=session)
    total = result['total']
    if total <= cap:
        return
    rows = '\n'.join(f'  {name:<40} {tokens:>6}' for name, tokens in result['per_tool'])
    raise AssertionError(
        f"mode {mode!r} tool schemas cost {total} tokens > cap {cap} "
        f"({result['count']} tools). Per-tool cost table (descending):\n{rows}"
    )


__all__ = [
    'TOOL_BUDGET_CAP',
    'measure_tools',
    'measure_mode',
    'assert_under_budget',
]
