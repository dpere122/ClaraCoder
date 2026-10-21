"""``wait_for_subagents`` and ``stop_subagent``: the main agent's handles on sub-agents it started.

Both address sub-agents by name (unique among a session's live ones) or id. Bound together with
``spawn_subagent`` (main agent-mode sessions only). A report returned here counts as delivered; see
:mod:`clara_coder_backend.lang_agent.subagents` for the other ways reports reach the main agent.
"""

from __future__ import annotations

import logging
from typing import Annotated

from langchain_core.tools import tool

from clara_coder_backend.domain import SessionState
from clara_coder_backend.lang_agent.subagents import (
    SubagentReport,
    SubagentRun,
    claim_subagent_report,
    find_subagent,
    live_subagent_runs,
    stop_subagent,
    wait_for_runs,
)
from clara_coder_backend.session import state
from clara_coder_backend.session.state import current_session_id
from clara_coder_backend.tools.tool_conventions import describe, tool_output_cap

logger = logging.getLogger('clara.tools.subagent_control')

WAIT_FOR_SUBAGENTS_NAME = 'wait_for_subagents'
STOP_SUBAGENT_NAME = 'stop_subagent'

#: Bounds on ``timeout_seconds``.
_MIN_WAIT_SEC = 1
_MAX_WAIT_SEC = 3_600
#: Cap on one result carrying several reports.
_RESULT_MAX_CHARS = 30_000


def _main_session() -> tuple[str, SessionState | None, str]:
    """(session id, main session, error) for the current call."""
    sid = (current_session_id.get() or '').strip()
    parent = state.sessions.get(sid) if sid else None
    if parent is None:
        return sid, None, 'Tool error: no active session.'
    if parent.subagent_parent_session_id:
        return sid, None, 'Tool error: sub-agents have no sub-agents of their own.'
    return sid, parent, ''


def _running_names(parent: SessionState) -> str:
    names = [f'`{run.name}`' for run in live_subagent_runs(parent)]
    return ', '.join(names) if names else 'none'


@tool(
    WAIT_FOR_SUBAGENTS_NAME,
    description=describe(
        'Wait for sub-agents you started to finish and get their reports',
        when="you need background sub-agents' results before going on",
        not_='a spawn call that already returned the report',
        shape='`names`: names or ids (omit for all); returns once they all finished or at the timeout '
        '(they keep running)',
    ),
)
async def wait_for_subagents_tool(
    names: Annotated[list[str] | None, 'sub-agent names or ids; omit for all of yours'] = None,
    timeout_seconds: Annotated[int, 'max seconds to wait'] = 600,
) -> str:
    _sid, parent, error = _main_session()
    if parent is None:
        return error
    unknown: list[str] = []
    targets: list[SubagentRun | SubagentReport] = []
    if names:
        for key in names:
            found = find_subagent(parent, str(key))
            if found is None:
                unknown.append(str(key))
            elif found not in targets:
                targets.append(found)
    else:
        targets = [*live_subagent_runs(parent), *parent.subagent_pending_reports.values()]
    if not targets:
        lines = []
        if unknown:
            lines.append('No sub-agent named ' + ', '.join(f'`{k}`' for k in unknown) + '.')
        lines.append(f'Nothing to wait for: running sub-agents: {_running_names(parent)}; no reports are waiting.')
        return '\n'.join(lines)

    try:
        timeout = float(max(_MIN_WAIT_SEC, min(int(timeout_seconds), _MAX_WAIT_SEC)))
    except (TypeError, ValueError):
        timeout = 600.0
    runs = [t for t in targets if isinstance(t, SubagentRun)]
    await wait_for_runs(runs, timeout=timeout)

    blocks: list[str] = []
    still: list[str] = []
    for target in targets:
        report = claim_subagent_report(parent, target.child_id)
        if report is not None:
            blocks.append(report.text.strip())
        elif isinstance(target, SubagentRun) and not target.finish:
            still.append(f'`{target.name}`')
    lines = list(blocks)
    if still:
        lines.append(
            f'Still running after {int(timeout)}s: {", ".join(still)}. Their reports reach you by themselves '
            'when they finish (or wait again / stop_subagent).'
        )
    if unknown:
        lines.append('No sub-agent named ' + ', '.join(f'`{k}`' for k in unknown) + '.')
    if not lines:
        lines.append('Their reports were already delivered to you.')
    return tool_output_cap('\n\n'.join(lines), _RESULT_MAX_CHARS)


@tool(
    STOP_SUBAGENT_NAME,
    description=describe(
        'Stop a running sub-agent you started and get its partial report',
        when='its task is no longer needed or it went off track',
        shape='`name`: its name or id',
    ),
)
async def stop_subagent_tool(
    name: Annotated[str, 'sub-agent name or id'],
) -> str:
    _sid, parent, error = _main_session()
    if parent is None:
        return error
    found = find_subagent(parent, name)
    if found is None:
        return f'Tool error: no sub-agent named `{(name or "").strip()}`. Running: {_running_names(parent)}.'
    if isinstance(found, SubagentRun) and not found.finish:
        await stop_subagent(found.child_id, by='the main agent')
    report = claim_subagent_report(parent, found.child_id)
    if report is None:
        if isinstance(found, SubagentRun) and not found.finish:
            return f'Sub-agent `{found.name}` was told to stop; its report reaches you when it has ended.'
        return f'Sub-agent `{found.name}` has ended; its report was already delivered to you.'
    if report.outcome != 'aborted':
        return 'It had already finished. ' + report.text
    return report.text


__all__ = [
    'STOP_SUBAGENT_NAME',
    'WAIT_FOR_SUBAGENTS_NAME',
    'stop_subagent_tool',
    'wait_for_subagents_tool',
]
