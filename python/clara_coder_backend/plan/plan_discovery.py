"""Free-form read-only discovery phase for plan mode.

The model explores the workspace with read-only tools and decides its own next
action at each step — it does NOT draft an up-front checklist of discovery
actions. It may split the exploration across read-only sub-agents. Only the implementation plan is planned ahead of time (see
:mod:`clara_coder_backend.plan.plan_execute`). The discovery summary produced here feeds the
implementation planner.
"""

from __future__ import annotations

PLAN_DISCOVERY_EXECUTE_LABEL = 'plan_discovery'

# Discovery is the slowest phase on local models; most of its cost is one-read-per-turn round trips.
_DISCOVERY_PACING_RULES = (
    '- Batch independent reads: when you already know several files or searches you need, call '
    'those tools together in one turn instead of one per turn.\n'
    '- Prefer targeted search over reading whole directories; read a file only when its contents '
    'change the plan.\n'
)

# Discovery's sub-agents are read-only (they inherit this phase's mode) and must finish before planning.
_DISCOVERY_SUBAGENT_RULES = (
    '- Sub-agents: when the user asks for them, or the objective spans several independent areas, '
    'split the exploration with `spawn_subagent` (several calls in one turn run in parallel). They '
    'are read-only here: give each one area and ask for facts back (paths, symbols, patterns), not '
    'changes. Fold their reports into your summary; the planner sees only your summary.\n'
)

# A fixed shape lets the planner ground files_to_change and turn Unknowns into open questions.
_DISCOVERY_SUMMARY_SHAPE = (
    'Use these headings (omit empty ones):\n'
    '- Relevant files: workspace-relative paths, each with one line on its role.\n'
    '- Patterns and conventions: how similar features are built here.\n'
    '- Constraints: tests, build, dependencies, or APIs the change must respect.\n'
    '- Unknowns: decisions only the user can make (these become clarifying questions).'
)


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
        f'{_DISCOVERY_PACING_RULES}'
        f'{_DISCOVERY_SUBAGENT_RULES}'
        '- Stop once you have enough context to plan the implementation.\n\n'
        'When finished, output a concise factual summary of your findings. This summary feeds the '
        f'implementation planner.\n{_DISCOVERY_SUMMARY_SHAPE}'
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
        f'{_DISCOVERY_PACING_RULES}'
        f'{_DISCOVERY_SUBAGENT_RULES}'
        '- If the answers need no new facts, stop immediately and say so.\n'
        '- Stop once you have enough context to rewrite the implementation plan.\n\n'
        'When finished, output a concise factual summary of the NEW findings only. This summary '
        'is appended to prior discovery for the planner.'
    )


__all__ = [
    'PLAN_DISCOVERY_EXECUTE_LABEL',
    'build_followup_discovery_prompt',
    'build_freeform_discovery_prompt',
]
