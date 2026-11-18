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

# The summary's ``Unknowns`` heading: plain, ``#`` (numbered or with more words after it), bold or a
# list item, with an optional note in brackets.
_UNKNOWNS_HEADING_RE = re.compile(
    r'^(?P<marker>#{1,6}\s*(?:\d+[.)]\s+)?|[-*+]\s+|\d+[.)]\s+)?(?P<underscores>__)?unknowns\b(?P<rest>.*)$',
    re.IGNORECASE,
)
_HEADING_NOTE_RE = re.compile(r'^\s*\([^)]*\)')
_SUMMARY_HEADING_RE = re.compile(r'^\s*(?:#{1,6}\s+\S|(?:\*\*|__).+(?:\*\*|__)\s*:?\s*$)')
_SUMMARY_ITEM_RE = re.compile(r'^\s*(?:[-*+]|\d+[.)]|[A-Za-z]\))\s+(?P<body>.+)$')
# A line that only introduces the answers ("Options:"), not an answer or part of the question.
_ANSWERS_LABEL_RE = re.compile(r'^(?:suggested\s+)?(?:options|answers|choices)\s*:?$', re.IGNORECASE)
_NO_UNKNOWNS_RE = re.compile(
    r'^\W*(?:none|n/?a|nothing|(?:there\s+(?:are|is)\s+)?no\s+(?:\w+\s+){0,2}'
    r'(?:unknowns|open|outstanding|decisions|questions))\b',
    re.IGNORECASE,
)
_CODE_SPAN_RE = re.compile(r'`[^`\n]+`')
_BOLD_RE = re.compile(r'\*\*(?=\S)(.+?)(?<=\S)\*\*')
_MASKED_SPAN_RE = re.compile(r'\x00(\d+)\x00')


def _plain(text: str) -> str:
    """Drop bold markers, which the question card would show as written.

    Code spans are left alone (``src/**/*.ts``), and ``__`` is not read as bold: in a summary about
    code it is far more often ``__init__``.
    """
    spans: list[str] = []

    def _mask(match: re.Match[str]) -> str:
        spans.append(match.group(0))
        return f'\x00{len(spans) - 1}\x00'

    stripped = _BOLD_RE.sub(r'\1', _CODE_SPAN_RE.sub(_mask, text))
    return _MASKED_SPAN_RE.sub(lambda m: spans[int(m.group(1))], stripped).strip()


def _indent(line: str) -> int:
    expanded = line.expandtabs(4)
    return len(expanded) - len(expanded.lstrip())


def _unknowns_heading(line: str) -> tuple[int | None, str] | None:
    """For the Unknowns heading: its indent when it is a list item (else None), and text after ``:``."""
    match = _UNKNOWNS_HEADING_RE.match(_plain(line))
    if match is None:
        return None
    marker = match.group('marker') or ''
    rest = match.group('rest')
    if match.group('underscores'):
        rest = rest.replace('__', '', 1)
    rest = _HEADING_NOTE_RE.sub('', rest).strip()
    if rest.startswith(':'):
        inline = rest[1:].strip()
    elif not rest or marker.startswith('#'):
        inline = ''  # a ``#`` heading may say more: "Unknowns for the user"
    else:
        return None  # a sentence that starts with the word
    return (_indent(line) if marker and not marker.startswith('#') else None), inline


def parse_discovery_unknowns(summary: str) -> list[OpenQuestion]:
    """The summary's Unknowns as questions: one per list item, its sub-bullets as suggested answers.

    Discovery lists there what only the user can decide. The planner has nothing more to go on than
    discovery had, so an Unknown it does not ask about can only have been guessed.

    Every question returned must be answered before the user can submit the card, so a line that is
    not clearly one (the next section, a note under an answer) is left out.
    """
    lines = (summary or '').splitlines()
    found = next(((i, h) for i, h in enumerate(map(_unknowns_heading, lines)) if h is not None), None)
    if found is None:
        return []
    start, (list_indent, inline) = found

    entries: list[list[str]] = [[inline]] if inline else []  # each: the question, then its answers
    item_indent: int | None = None  # indent of the questions
    answer_indent: int | None = None  # indent of the current question's answers
    wrap_indent: int | None = None  # indent of the item a wrapped line would continue
    for line in lines[start + 1 :]:
        if not line.strip():
            continue
        indent = _indent(line)
        if list_indent is not None and indent <= list_indent:
            break  # back out to the list the heading itself was an item of: the next section
        item = _SUMMARY_ITEM_RE.match(line)
        if item is None:
            if _SUMMARY_HEADING_RE.match(line) or (entries and indent == 0):
                break  # the next section, or a closing paragraph
            text = _plain(line)
            if wrap_indent is not None and indent > wrap_indent and not _ANSWERS_LABEL_RE.match(text):
                entries[-1][-1] = f'{entries[-1][-1]} {text}'
            continue
        body = _plain(item.group('body'))
        if not body or _ANSWERS_LABEL_RE.match(body):
            continue
        if item_indent is None:
            item_indent = indent
        if indent < item_indent:
            break  # a list further out than the questions
        if indent == item_indent or not entries:
            entries.append([body])
            answer_indent = None
        elif answer_indent is None or indent <= answer_indent:
            entries[-1].append(body)
            answer_indent = indent
        else:
            wrap_indent = None
            continue  # a note under an answer
        wrap_indent = indent

    asked = [entry for entry in entries if not _NO_UNKNOWNS_RE.match(entry[0])]
    return [
        OpenQuestion(id=f'q-{n}', prompt=entry[0], options=entry[1:])
        for n, entry in enumerate(asked, start=1)
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
