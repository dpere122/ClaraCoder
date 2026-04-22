"""Shared coaching text for Clara agents: capability framing, tool recovery, and outcome nudges."""

from __future__ import annotations

# Distinctive substring for lightweight regression tests (see test_llm_coaching_middleware).
SYSTEM_COACHING_MARKER = 'Clara capability and tool coaching'


def system_prompt_coaching_append() -> str:
    """Short block appended to Clara-related system prompts (outer, nested, planner)."""
    return (
        f'\n\n## {SYSTEM_COACHING_MARKER}\n'
        '- You are a capable coding assistant: trust your reasoning, use tools deliberately, and '
        'ground claims in what you actually read.\n'
        '- Prefer the model’s structured tool/function channel for every tool invocation; never put '
        'tool calls, arguments, or <tool_call>-style markup in plain assistant text—those are ignored.\n'
        '- When a tool returns a normal result, use it to move the task forward with a clear next step.\n'
        '- When a tool result begins with `Tool error:`, treat it as a recoverable signal: read the '
        'message, adjust arguments or your approach, and retry once with a concrete fix; avoid repeating '
        'the same failed call without a change.\n'
    )


def tool_error_coaching_suffix() -> str:
    """Appended to tool results that start with ``Tool error:`` (middleware only)."""
    return (
        '\n\n[Runtime coaching] That outcome was a tool-side error or validation failure—not a judgment '
        'of your ability. Parse the error text, fix the arguments or strategy, and retry once with a '
        'clear change. If it still fails, summarize the blocker for the user.'
    )


def tool_success_coaching_suffix(tool_name: str) -> str:
    """Brief positive nudge after high-signal successful tool calls (middleware only)."""
    return (
        f'\n\n[Runtime coaching] `{tool_name}` completed successfully—good progress. '
        'Briefly confirm what changed (if relevant) and continue with the next deliberate step toward the goal.'
    )
