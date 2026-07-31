"""Free-form read-only discovery phase for plan mode.

The model explores the workspace with read-only tools and decides its own next
action at each step — it does NOT draft an up-front checklist of discovery
actions. Only the implementation plan is planned ahead of time (see
:mod:`clara_coder_backend.plan_execute`). The discovery summary produced here feeds the
implementation planner.
"""

from __future__ import annotations

PLAN_DISCOVERY_EXECUTE_LABEL = 'plan_discovery'


def build_freeform_discovery_prompt(objective: str) -> str:
    """ReAct executor user message for the free-form discovery pass."""
    return (
        f'User objective:\n{objective}\n\n'
        'You are in plan mode, discovery phase. Explore the workspace with read-only tools '
        '(search, read files, list structure, semantic lookup) to understand what the objective '
        'requires. Decide your own next read-only action as you go — do NOT draft a checklist or '
        'numbered list of discovery actions up front.\n\n'
        'Rules:\n'
        '- Use read-only / discovery tools only. Do not edit, create, delete, stage, transfer, or '
        'run mutating commands.\n'
        '- Gather concrete facts: file paths, symbols, existing patterns, and constraints relevant '
        'to the objective.\n'
        '- Stop once you have enough context to plan the implementation.\n\n'
        'When finished, output a concise factual summary of your findings (paths, modules, '
        'patterns, constraints). This summary feeds the implementation planner.'
    )


__all__ = [
    'PLAN_DISCOVERY_EXECUTE_LABEL',
    'build_freeform_discovery_prompt',
]
