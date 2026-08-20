"""Free-form read-only discovery phase for plan mode.

The model explores the workspace with read-only tools and decides its own next
action at each step — it does NOT draft an up-front checklist of discovery
actions. Only the implementation plan is planned ahead of time (see
:mod:`clara_coder_backend.plan.plan_execute`). The discovery summary produced here feeds the
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


def build_followup_discovery_prompt(
    objective: str,
    *,
    resolved_answers: str,
    prior_summary: str = '',
) -> str:
    """Read-only discovery focused on gaps opened by the user's clarifying answers."""
    answers = (resolved_answers or '').strip() or '(none)'
    prior = (prior_summary or '').strip()
    prior_block = (
        f'Prior discovery summary (already gathered — do not repeat this work):\n{prior}\n\n'
        if prior
        else ''
    )
    return (
        f'User objective:\n{objective}\n\n'
        f'{prior_block}'
        'The user answered clarifying questions. Those answers are authoritative:\n'
        f'{answers}\n\n'
        'You are in plan mode, follow-up discovery. Use read-only tools to fill gaps these '
        'answers opened (paths, APIs, symbols, patterns). Do not re-explore the whole workspace '
        'or draft a checklist of discovery actions.\n\n'
        'Rules:\n'
        '- Use read-only / discovery tools only. Do not edit, create, delete, stage, transfer, or '
        'run mutating commands.\n'
        '- Focus on facts that change the implementation plan given the answers above.\n'
        '- Stop once you have enough context to rewrite the implementation plan.\n\n'
        'When finished, output a concise factual summary of the NEW findings only. This summary '
        'is appended to prior discovery for the planner.'
    )


__all__ = [
    'PLAN_DISCOVERY_EXECUTE_LABEL',
    'build_followup_discovery_prompt',
    'build_freeform_discovery_prompt',
]
