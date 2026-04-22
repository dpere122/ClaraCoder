"""Shared coding-planner primitives: plan parsing, progress snapshots, staging bookkeeping.

Used by :mod:`nemo_backend.agents.coding_planner.orchestrator` and thin exports in ``pipeline.py``.
"""

from __future__ import annotations

import asyncio
import logging
import re
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

from nemo_backend.agents.orchestration.nested_pipeline import NESTED_WORKER_STREAM_END
from nemo_backend.domain import ProjectReviewReentryRequest, SessionState
from nemo_backend.lsp.file_policy import is_programming_path
from nemo_backend.prompt_blocks import routing_handoff_contract
from nemo_backend.state import get_active_connection
from nemo_backend.config import (
    NEMO_PLANNER_COMPLEXITY_BREADTH_WEIGHT,
    NEMO_PLANNER_COMPLEXITY_CONSTRAINT_WEIGHT,
    NEMO_PLANNER_COMPLEXITY_KEYWORD_WEIGHT,
    NEMO_PLANNER_COMPLEXITY_MAX_SCORE,
    NEMO_PLANNER_FORCE_DISCOVERY_SCORE,
    NEMO_PLANNER_MAX_STEP_TEXT_CHARS,
    NEMO_PLANNER_REQUIRE_DISCOVERY_FOR_CODE_PATHS,
    NEMO_PLANNER_REQUEST_LARGE_CHARS,
    NEMO_PLANNER_REQUEST_MEDIUM_CHARS,
    NEMO_PLANNER_REQUEST_SMALL_CHARS,
    NEMO_PLANNER_STEP_RESULT_MAX_CHARS,
)
from nemo_backend.python_env import resolve_python_workspace_root
from pathlib import Path

logger = logging.getLogger('nemo.agent.langgraph.coding_planner')

FINAL_PROJECT_REVIEW_FAILURE_PREFIX = 'Tool error: final project review failed.'

PLANNER_NO_TRANSFER_STEP_RETRY_SUFFIX = (
    '\n\nPlanner note: no staged file was approved into the workspace during this step '
    '(no successful `transfer_staged_file_to_workspace` for a new path). The checklist item stays incomplete. '
    'Outer Clara should **call `plan_and_modify` again** with a revised routing handoff and narrower scope '
    '(or split the work), embedding the minimum extra context to unblock the nested writer or reviewer—do not '
    'treat the task as finished unless this step truly required no file change (for example manifest-only '
    'dependency work).'
)

_PLAN_STEP_RE = re.compile(r'^\s*(?:[-*]|\d+[.)])\s+(.*\S)\s*$')
_INLINE_LIST_MARKER_BOUNDARY = re.compile(r'(?<=[^\d\s])\s+(?=\d{1,3}[.)]\s+\S)')
_READ_ONLY_STEP_PREFIX_RE = re.compile(
    r'^(?:read|inspect|search|list|scan|review|open|explore|look\s+at|check|gather|analyze|understand)\b'
)
_CONSTRAINT_HINT_RE = re.compile(
    r'\b(?:must|should|need(?:s)?\s+to|without|with|before|after|only|avoid|include|exclude|instead|also|while|when|unless)\b',
    re.IGNORECASE,
)
_CROSS_CUTTING_KEYWORDS = (
    'test',
    'tests',
    'refactor',
    'migration',
    'backend',
    'frontend',
    'renderer',
    'ipc',
    'ui',
    'api',
    'config',
    'stream',
    'schedule',
    'sync',
)
_PATH_HINT_RE = re.compile(r'`[^`]+`|(?:[\w.-]+[\\/])+[\w.-]+|[\w.-]+\.[A-Za-z0-9]+')


def scope_text_mentions_programming_paths(*text_parts: str) -> bool:
    """True if any path-like token in the given text is a code-review / programming extension."""
    combined = '\n'.join((p or '').strip() for p in text_parts if (p or '').strip())
    for m in _PATH_HINT_RE.finditer(combined):
        token = m.group(0).strip('`').strip()
        if token and is_programming_path(token):
            return True
    return False


@dataclass(frozen=True)
class TaskComplexityProfile:
    char_count: int
    score: int
    target_steps: int
    min_steps: int
    max_steps: int
    requires_discovery: bool


def task_complexity_profile(task_summary: str) -> TaskComplexityProfile:
    cleaned = (task_summary or '').strip()
    lowered = cleaned.lower()
    char_count = len(cleaned)

    char_score = 0
    if char_count >= NEMO_PLANNER_REQUEST_SMALL_CHARS:
        char_score += 1
    if char_count >= NEMO_PLANNER_REQUEST_MEDIUM_CHARS:
        char_score += 1
    if char_count >= NEMO_PLANNER_REQUEST_LARGE_CHARS:
        char_score += 1

    path_hints = {m.group(0).strip('`') for m in _PATH_HINT_RE.finditer(cleaned)}
    breadth_score = max(0, len(path_hints) - 1)
    breadth_score += sum(1 for keyword in ('backend', 'frontend', 'renderer', 'ipc', 'ui', 'api') if keyword in lowered)
    breadth_score = min(3, breadth_score)

    constraint_score = min(3, len(_CONSTRAINT_HINT_RE.findall(cleaned)))
    keyword_score = min(3, sum(1 for keyword in _CROSS_CUTTING_KEYWORDS if keyword in lowered))

    raw_score = (
        char_score
        + breadth_score * NEMO_PLANNER_COMPLEXITY_BREADTH_WEIGHT
        + constraint_score * NEMO_PLANNER_COMPLEXITY_CONSTRAINT_WEIGHT
        + keyword_score * NEMO_PLANNER_COMPLEXITY_KEYWORD_WEIGHT
    )
    score = max(0, min(raw_score, NEMO_PLANNER_COMPLEXITY_MAX_SCORE))

    target_steps = 2
    if score >= 2:
        target_steps += 1
    if score >= 4:
        target_steps += 1
    if score >= 6:
        target_steps += 1
    if score >= 8:
        target_steps += 1

    min_steps = max(2, target_steps - 1)
    max_steps = max(min_steps, target_steps + 1)
    requires_discovery = score >= NEMO_PLANNER_FORCE_DISCOVERY_SCORE or (
        char_count >= NEMO_PLANNER_REQUEST_SMALL_CHARS and not path_hints
    )
    return TaskComplexityProfile(
        char_count=char_count,
        score=score,
        target_steps=target_steps,
        min_steps=min_steps,
        max_steps=max_steps,
        requires_discovery=requires_discovery,
    )


def plan_requirements_text(profile: TaskComplexityProfile, task_summary: str = '') -> str:
    lines = [
        f'- Request length: {profile.char_count} chars; computed complexity score: {profile.score}.',
        (
            f'- Record between {profile.min_steps} and {profile.max_steps} build steps; '
            f'aim for about {profile.target_steps}.'
        ),
        f'- Keep each recorded step under {NEMO_PLANNER_MAX_STEP_TEXT_CHARS} characters.',
        '- The checklist must contain only implementation/build/test/verification steps.',
        '- For Python work, add a test step only when the user asked for tests, concrete test criteria exist, or nearby tests clearly need updates; otherwise prefer runtime verification.',
    ]
    if profile.requires_discovery or (
        NEMO_PLANNER_REQUIRE_DISCOVERY_FOR_CODE_PATHS
        and scope_text_mentions_programming_paths(task_summary)
    ):
        lines.append('- Perform discovery reads/searches before recording the build plan for this task.')
    return '\n'.join(lines)


def _is_read_only_step(step_text: str) -> bool:
    return bool(_READ_ONLY_STEP_PREFIX_RE.match(step_text.strip().lower()))


@contextmanager
def suppress_parent_graph_model_token_sse(session: SessionState):
    """Hide planner subgraph LLM tokens on the parent graph's ``astream_events`` queue."""
    session.suppress_parent_graph_model_token_sse = True
    try:
        yield
    finally:
        session.suppress_parent_graph_model_token_sse = False


async def enqueue_planner_event(nested_q: Any, stream_tag: str, ev: dict[str, Any]) -> None:
    await nested_q.put((stream_tag, ev))


async def enqueue_planner_progress(nested_q: Any, stream_tag: str, planner: dict[str, Any]) -> None:
    await enqueue_planner_event(nested_q, stream_tag, {'event': 'planner_progress', 'data': {'planner': planner}})


def truncate_step_result(text: str) -> str:
    if len(text) <= NEMO_PLANNER_STEP_RESULT_MAX_CHARS:
        return text
    return (
        text[:NEMO_PLANNER_STEP_RESULT_MAX_CHARS]
        + '\n\n[Step result truncated; increase NEMO_PLANNER_STEP_RESULT_MAX_CHARS if needed.]'
    )


def snapshot_workspace_applied_flags(session: SessionState) -> dict[str, bool]:
    return {
        rel: bool(getattr(entry, 'workspace_applied', False))
        for rel, entry in session.pending_edit_stagings.items()
    }


def had_new_workspace_transfer_since(session: SessionState, before: dict[str, bool]) -> bool:
    for rel, entry in session.pending_edit_stagings.items():
        if not getattr(entry, 'workspace_applied', False):
            continue
        if not before.get(rel, False):
            return True
    return False


def normalize_plan_steps_raw_text(plan_steps: str) -> str:
    text = (plan_steps or '').replace('\r\n', '\n').strip()
    if not text:
        return text
    return _INLINE_LIST_MARKER_BOUNDARY.sub('\n', text)


def next_plan_step_index(existing: list[dict[str, str]]) -> int:
    m = 0
    for s in existing:
        sid = str(s.get('id') or '')
        if sid.startswith('step-') and sid[5:].isdigit():
            m = max(m, int(sid[5:]))
    return m + 1


def parse_plan_steps(plan_steps: str, *, existing_steps: list[dict[str, str]] | None = None) -> list[dict[str, str]]:
    steps: list[dict[str, str]] = []
    start = next_plan_step_index(existing_steps) if existing_steps else 1
    for line in normalize_plan_steps_raw_text(plan_steps).splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        match = _PLAN_STEP_RE.match(line)
        text = (match.group(1) if match else stripped).strip()
        if not text:
            continue
        idx = start + len(steps)
        steps.append({'id': f'step-{idx}', 'text': text, 'state': 'pending'})
    return steps


def validate_initial_plan_steps(
    parsed_steps: list[dict[str, str]],
    profile: TaskComplexityProfile,
    *,
    discovery_completed: bool,
    requires_discovery: bool | None = None,
) -> str | None:
    if not parsed_steps:
        return 'Tool error: plan_steps must contain at least one numbered or bulleted item.'
    need_discovery = profile.requires_discovery if requires_discovery is None else requires_discovery
    if need_discovery and not discovery_completed:
        return (
            'Tool error: gather missing workspace context with planner read/search/list tools before recording '
            'the build plan for this task.'
        )
    floor_min = max(2, profile.min_steps - 1)
    if len(parsed_steps) < floor_min:
        return (
            f'Tool error: this task needs at least {floor_min} concrete build steps based on its complexity '
            f'(target about {profile.target_steps}). Put each step on its own line, or separate inline items '
            'like "1. ... 2. ..." with spaces. Do not record one broad step when several are required.'
        )
    if len(parsed_steps) > profile.max_steps:
        return (
            f'Tool error: keep the initial plan to at most {profile.max_steps} build steps. '
            'Combine tiny adjacent steps into larger build actions.'
        )
    for step in parsed_steps:
        text = str(step.get('text') or '').strip()
        if len(text) > NEMO_PLANNER_MAX_STEP_TEXT_CHARS:
            return (
                'Tool error: keep each recorded step concise and action-oriented. '
                f'Steps must stay under {NEMO_PLANNER_MAX_STEP_TEXT_CHARS} characters.'
            )
        if _is_read_only_step(text):
            return (
                'Tool error: the recorded checklist must contain build steps only. '
                'Do not include read/search/list/inspect/review/open actions as plan steps.'
            )
    return None


def validate_probe_plan_steps(parsed_steps: list[dict[str, str]]) -> str | None:
    if not parsed_steps:
        return 'empty plan'
    if len(parsed_steps) > 6:
        return 'too many probe steps'
    for step in parsed_steps:
        text = str(step.get('text') or '').strip()
        if not text:
            return 'empty step text'
        if len(text) > NEMO_PLANNER_MAX_STEP_TEXT_CHARS:
            return 'step too long'
        if _is_read_only_step(text):
            return 'read-only step'
    return None


def compose_fast_path_step_instruction(
    task_summary: str,
    step_text: str,
    *,
    step_index: int = 1,
    total_steps: int = 1,
    discovery_notes: str = '',
) -> str:
    counter = f'Step {step_index} of {total_steps}.'
    notes = ''
    dn = (discovery_notes or '').strip()
    if dn:
        notes = f'\n\n**Discovery notes (orchestrator):**\n{dn}\n'
    transfer_order = (
        '\n\n**Deterministic transfer order:** When multiple files are staged in this step, call '
        '`transfer_staged_file_to_workspace` in **lexicographic ascending order** of workspace-relative POSIX paths '
        '(sorted strings).'
    )
    return (
        f'{routing_handoff_contract()}\n\n'
        f'{counter}{notes}\n'
        f'**Original plan_and_modify task summary:**\n{(task_summary or "").strip()}\n\n'
        f'**Recorded plan step (execute this now):**\n{(step_text or "").strip()}\n\n'
        'If **Operation:** / **Paths:** / **Existence:** are not explicit above, derive them from the task and step '
        'before the nested router acts.'
        f'{transfer_order}'
    )


def planner_progress_snapshot(
    steps: list[dict[str, str]],
    phase: str,
    *,
    active_step_id: str = '',
    plan_ready: bool = False,
    final_review_state: str = 'pending',
    final_review_attempts: int = 0,
    final_review_max_attempts: int = 0,
    final_review_summary: str = '',
    project_review_reentry: dict[str, Any] | None = None,
    orchestrator_phase: str = '',
    recommended_transfer_order: list[str] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        'streamTag': 'planner',
        'phase': phase,
        'planReady': plan_ready,
        'steps': [dict(step) for step in steps],
        'finalReviewState': final_review_state,
        'finalReviewAttempts': final_review_attempts,
        'finalReviewMaxAttempts': final_review_max_attempts,
    }
    if active_step_id:
        payload['activeStepId'] = active_step_id
    if final_review_summary:
        payload['finalReviewSummary'] = final_review_summary
    if project_review_reentry:
        payload['projectReviewReentry'] = project_review_reentry
    if orchestrator_phase:
        payload['orchestratorPhase'] = orchestrator_phase
    if recommended_transfer_order:
        payload['recommendedTransferOrder'] = list(recommended_transfer_order)
    return payload


def planner_terminal_phase_with_review(steps: list[dict[str, str]], *, final_review_state: str) -> str:
    base = planner_terminal_phase(steps)
    if base in {'discovery', 'executing', 'error'}:
        return base
    if final_review_state == 'error':
        return 'error'
    if final_review_state != 'complete':
        return 'executing'
    return 'complete'


def planner_terminal_phase(steps: list[dict[str, str]]) -> str:
    if not steps:
        return 'discovery'
    if any(step.get('state') == 'error' for step in steps):
        return 'error'
    if any(step.get('state') in {'pending', 'running'} for step in steps):
        return 'executing'
    return 'complete'


def all_recorded_steps_complete(steps: list[dict[str, str]]) -> bool:
    return bool(steps) and all(step.get('state') == 'complete' for step in steps)


def format_plan_steps_for_review(steps: list[dict[str, str]]) -> str:
    return '\n'.join(f'- {str(step.get("text") or "").strip()}' for step in steps if str(step.get('text') or '').strip())


def build_final_project_review_instruction(task_summary: str, steps: list[dict[str, str]]) -> str:
    recorded_steps = format_plan_steps_for_review(steps) or '- (no recorded steps)'
    return (
        'Run the final project review for this completed task.\n\n'
        f'Original task summary:\n{task_summary.strip() or "(empty task summary)"}\n\n'
        'Recorded implementation steps:\n'
        f'{recorded_steps}\n\n'
        'Review the current workspace as a whole. For Python work, ensure the workspace virtual environment exists, '
        'use dependency tools to repair/install packages when needed, run a smoke test when there is an obvious app '
        'entrypoint, and run workspace pytest only when the workspace or task provides a real pytest signal.'
    )


def project_review_reentry_payload(request: ProjectReviewReentryRequest | None) -> dict[str, Any] | None:
    if request is None:
        return None
    return {
        'originalTaskSummary': request.original_task_summary,
        'nextTaskSummary': request.next_task_summary,
        'reviewFeedback': request.review_feedback,
        'recordedSteps': list(request.recorded_steps),
        'finalReviewAttempts': request.final_review_attempts,
        'retryBudget': request.retry_budget,
        'terminalReason': request.terminal_reason,
    }


def auto_remediation_step_text_from_final_review(review_result: str) -> str:
    header = (
        'Remediate the failed final project review: make the minimum workspace changes implied by the reviewer '
        'output below, then expect another `run_final_project_review` after this step completes.\n\n'
        'Reviewer output:\n'
    )
    max_body = max(400, NEMO_PLANNER_MAX_STEP_TEXT_CHARS - len(header) - 48)
    body = (review_result or '').strip()
    if len(body) > max_body:
        body = body[:max_body].rstrip() + '\n\n[truncated]'
    return header + body


def needs_python_env_bootstrap(session: SessionState) -> bool:
    workspace_path = (session.workspace_path or '').strip()
    if not workspace_path:
        return False
    project_root, _label = resolve_python_workspace_root(Path(workspace_path), allow_workspace_root_fallback=False)
    if project_root is None:
        return False
    if not session.python_workspace_python_executable:
        return True
    if not session.python_workspace_venv_path:
        return True
    return not Path(session.python_workspace_venv_path).is_dir()


def sorted_pending_staging_paths(session: SessionState) -> list[str]:
    """Lexicographic order of paths with pending staged drafts (predictable transfer order hint)."""
    return sorted(session.pending_edit_stagings.keys())


class StepProxyQueue:
    """Proxy that forwards events to *outer_q* but swallows ``NESTED_WORKER_STREAM_END``."""

    def __init__(self, outer_q: asyncio.Queue) -> None:
        self._outer_q = outer_q

    async def put(self, item: Any) -> None:
        if item is NESTED_WORKER_STREAM_END:
            return
        await self._outer_q.put(item)


def default_final_review_max_attempts() -> int:
    try:
        return max(0, int(get_active_connection().plan_retry_attempts_count))
    except Exception:
        return 0


def select_step_for_execution(
    steps: list[dict[str, str]],
    step_instruction: str,
) -> dict[str, str] | None:
    """Return the first incomplete step; ``step_instruction`` is ignored (FIFO execution)."""
    del step_instruction
    for step in steps:
        if step.get('state') != 'complete':
            return step
    return None


def planner_has_incomplete_work(initial_plan_recorded: bool, steps: list[dict[str, str]]) -> bool:
    if not initial_plan_recorded:
        return True
    return any(step.get('state') != 'complete' for step in steps)
