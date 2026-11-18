"""Free-form read-only discovery phase for plan mode.

The model explores the workspace with read-only tools and decides its own next
action at each step — it does NOT draft an up-front checklist of discovery
actions. It may split the exploration across read-only sub-agents. Only the implementation plan is planned ahead of time (see
:mod:`clara_coder_backend.plan.plan_execute`). The discovery summary produced here feeds the
implementation planner.
"""

from __future__ import annotations

import re

from clara_coder_backend.plan.build_plan_store import OpenQuestion

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
    '- Unknowns: decisions only the user can make (these become clarifying questions), never facts '
    'you could look up. One bullet per decision, phrased as a question, with 2-4 suggested answers '
    'as indented sub-bullets, the one you recommend first.'
)

# The summary's ``Unknowns`` heading: plain, ``#``, bold or a bullet, with an optional note in brackets.
_UNKNOWNS_HEADING_RE = re.compile(
    r'^\s*(?:#{1,6}\s*|[-*+]\s+|\d+[.)]\s+)?unknowns\s*(?:\([^)]*\))?\s*(?::\s*(?P<inline>.*))?$',
    re.IGNORECASE,
)
_SUMMARY_HEADING_RE = re.compile(r'^\s*(?:#{1,6}\s+\S|(?:\*\*|__).+(?:\*\*|__)\s*:?\s*$)')
_SUMMARY_ITEM_RE = re.compile(r'^(?P<indent>\s*)(?:[-*+]|\d+[.)])\s+(?P<body>.+)$')
_NO_UNKNOWNS_RE = re.compile(
    r'^\W*(?:none|n/?a|nothing|no\s+(?:unknowns|open|outstanding|decisions|questions))\b',
    re.IGNORECASE,
)


def _plain(text: str) -> str:
    return text.replace('**', '').replace('__', '').strip()


def parse_discovery_unknowns(summary: str) -> list[OpenQuestion]:
    """The summary's Unknowns as questions: one per list item, its sub-bullets as suggested answers.

    Discovery lists there what only the user can decide. The planner has nothing more to go on than
    discovery had, so an Unknown it does not ask about can only have been guessed.
    """
    lines = (summary or '').splitlines()
    start = next((i for i, line in enumerate(lines) if _UNKNOWNS_HEADING_RE.match(_plain(line))), None)
    if start is None:
        return []

    prompts: list[str] = []
    options: list[list[str]] = []
    heading = _UNKNOWNS_HEADING_RE.match(_plain(lines[start]))
    inline = (heading.group('inline') or '').strip() if heading else ''
    if inline:
        prompts.append(inline)
        options.append([])

    item_indent: int | None = None
    for line in lines[start + 1 :]:
        if not line.strip():
            continue
        item = _SUMMARY_ITEM_RE.match(line)
        if item is None:
            if _SUMMARY_HEADING_RE.match(line) or (prompts and not line[:1].isspace()):
                break  # the next section, or a closing paragraph
            continue
        indent = len(item.group('indent').expandtabs(4))
        body = _plain(item.group('body'))
        if item_indent is None:
            item_indent = indent
        if indent < item_indent:
            break  # back out to the list the heading itself was an item of
        if not body:
            continue
        if indent > item_indent and prompts:
            options[-1].append(body)
        else:
            prompts.append(body)
            options.append([])

    return [
        OpenQuestion(id=f'q-{n}', prompt=prompt, options=opts)
        for n, (prompt, opts) in enumerate(
            ((p, o) for p, o in zip(prompts, options) if not _NO_UNKNOWNS_RE.match(p)),
            start=1,
        )
    ]


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


def build_answer_lookup_prompt(objective: str, *, typed_answers: str, prior_summary: str = '') -> str:
    """Short read-only lookup for what the user's typed answers mention.

    Option answers come from the planner's own grounded choices; a typed answer can name code that
    discovery never looked at, so only those answers get a lookup before the rewrite.
    """
    prior = (prior_summary or '').strip()
    prior_block = f'Discovery already found (do not repeat this work):\n{prior}\n\n' if prior else ''
    return (
        f'User objective:\n{objective}\n\n'
        f'{prior_block}'
        'The user typed these answers to the plan\'s questions. They are authoritative:\n'
        f'{typed_answers.strip()}\n\n'
        'You are in plan mode, answer lookup. Use read-only tools to find only what these answers '
        'name or imply that the findings above do not cover (files, components, APIs, symbols, '
        'patterns). Do not re-explore the workspace or draft a checklist of actions.\n\n'
        'Rules:\n'
        '- Use read-only / discovery tools only. Do not edit, create, delete, stage, transfer, or '
        'run mutating commands.\n'
        f'{_DISCOVERY_PACING_RULES}'
        '- If the answers need no new facts, stop immediately and say so.\n\n'
        'When finished, output a concise factual summary of the NEW findings only (paths with their '
        'role, relevant symbols and patterns). It is added to the findings above for the planner.'
    )


__all__ = [
    'PLAN_DISCOVERY_EXECUTE_LABEL',
    'build_answer_lookup_prompt',
    'build_freeform_discovery_prompt',
    'parse_discovery_unknowns',
]
