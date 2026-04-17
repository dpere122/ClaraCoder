"""Coding planner LangGraph agent: reads workspace, plans, then delegates steps to the router/specialists."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
import re
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

from langchain.agents import create_agent
from pydantic import BaseModel, Field
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool

from nemo_backend.agents.coding_planner.prompts import (
    build_coding_planner_reflection_prompt,
    build_coding_planner_system_prompt,
    build_coding_planner_task_prompt,
)
from nemo_backend.agents.orchestration.nested_pipeline import (
    NESTED_WORKER_STREAM_END,
    enqueue_plan_and_modify_outer_brief,
    run_final_project_review_stream,
    run_planning_nested_stream,
)
from nemo_backend.config import (
    MAX_AGENT_STEPS,
    NEMO_PLANNER_COMPLEXITY_BREADTH_WEIGHT,
    NEMO_PLANNER_COMPLEXITY_CONSTRAINT_WEIGHT,
    NEMO_PLANNER_COMPLEXITY_KEYWORD_WEIGHT,
    NEMO_PLANNER_COMPLEXITY_MAX_SCORE,
    NEMO_PLANNER_FORCE_DISCOVERY_SCORE,
    NEMO_PLANNER_MAX_STEP_TEXT_CHARS,
    NEMO_PLANNER_REFLECTION_RETRIES,
    NEMO_PLANNER_REQUIRE_DISCOVERY_FOR_CODE_PATHS,
    NEMO_PLANNER_REQUEST_LARGE_CHARS,
    NEMO_PLANNER_REQUEST_MEDIUM_CHARS,
    NEMO_PLANNER_REQUEST_SMALL_CHARS,
    NEMO_PLANNER_STEP_RESULT_MAX_CHARS,
    NEMO_PLAN_FAST_PATH_MAX_STEPS,
    NEMO_PLAN_PROBE_ENABLED,
    NEMO_PLAN_SKIP_PROBE_MIN_COMPLEXITY_MAX_STEPS,
)
from nemo_backend.domain import ProjectReviewReentryRequest, SessionState
from nemo_backend.edit_tool import edit_tools_for_strict
from nemo_backend.empty_response_middleware import EmptyResponseNudgeMiddleware
from nemo_backend.llm import build_llm
from nemo_backend.lsp.file_policy import is_programming_path
from nemo_backend.lsp.tools import (
    lsp_find_definition,
    lsp_find_references,
    lsp_get_diagnostics,
    lsp_get_document_symbols,
    lsp_hover,
)
from nemo_backend.messages import final_assistant_text
from nemo_backend.prompt_blocks import routing_handoff_contract
from nemo_backend.planner_task_retry_middleware import PlannerTaskRetryMiddleware
from nemo_backend.python_env import ensure_session_python_workspace_env, resolve_python_workspace_root
from nemo_backend.python_env_tools import ensure_python_workspace_env_tool
from nemo_backend.state import get_active_connection, runtime_config
from nemo_backend.workspace_tools import list_workspace_directory, read_workspace_file, search_workspace

logger = logging.getLogger('nemo.agent.langgraph.coding_planner')
_FINAL_PROJECT_REVIEW_FAILURE_PREFIX = 'Tool error: final project review failed.'
_PLAN_STEP_RE = re.compile(r'^\s*(?:[-*]|\d+[.)])\s+(.*\S)\s*$')
# Models often emit "1. ... 2. ... 3. ..." on one line; line-only parsing would collapse to one step.
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


class _PlanProbeSteps(BaseModel):
    """Structured build-only steps from the plan probe LLM (1–6 items; orchestrator branches on count)."""

    steps: list[str] = Field(
        min_length=1,
        max_length=6,
        description='Numbered implementation steps only; no read/search/list steps.',
    )


@dataclass(frozen=True)
class _TaskComplexityProfile:
    char_count: int
    score: int
    target_steps: int
    min_steps: int
    max_steps: int
    requires_discovery: bool


def _task_complexity_profile(task_summary: str) -> _TaskComplexityProfile:
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
    return _TaskComplexityProfile(
        char_count=char_count,
        score=score,
        target_steps=target_steps,
        min_steps=min_steps,
        max_steps=max_steps,
        requires_discovery=requires_discovery,
    )


def _plan_requirements_text(profile: _TaskComplexityProfile, task_summary: str = '') -> str:
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
        lines.append('- Perform discovery reads/searches before calling `record_plan` for this task.')
    return '\n'.join(lines)


def _is_read_only_step(step_text: str) -> bool:
    return bool(_READ_ONLY_STEP_PREFIX_RE.match(step_text.strip().lower()))


@contextmanager
def _suppress_parent_graph_model_token_sse(session: SessionState):
    """Hide planner subgraph LLM tokens on the parent graph's ``astream_events`` queue."""
    session.suppress_parent_graph_model_token_sse = True
    try:
        yield
    finally:
        session.suppress_parent_graph_model_token_sse = False


async def _enqueue_planner_event(nested_q: Any, stream_tag: str, ev: dict[str, Any]) -> None:
    await nested_q.put((stream_tag, ev))


async def _enqueue_planner_progress(nested_q: Any, stream_tag: str, planner: dict[str, Any]) -> None:
    await _enqueue_planner_event(nested_q, stream_tag, {'event': 'planner_progress', 'data': {'planner': planner}})


def _truncate_step_result(text: str) -> str:
    if len(text) <= NEMO_PLANNER_STEP_RESULT_MAX_CHARS:
        return text
    return (
        text[:NEMO_PLANNER_STEP_RESULT_MAX_CHARS]
        + '\n\n[Step result truncated; increase NEMO_PLANNER_STEP_RESULT_MAX_CHARS if needed.]'
    )


def _planner_follow_up_context_note(initial_plan_recorded: bool, final_review_state: str) -> str:
    if not initial_plan_recorded:
        return ''
    if final_review_state == 'complete':
        return (
            '\n\nPlanner note: the last final project review passed. If more implementation is needed, '
            'call `record_plan` again with new build-only steps, run `execute_plan_step` for each, '
            'then `run_final_project_review` again.'
        )
    return (
        '\n\nPlanner note: the checklist is recorded and locked until final review completes. '
        'Use this context only to continue the current recorded step or final review. '
        'Do not call `record_plan` again until `run_final_project_review` has succeeded or failed.'
    )


def _next_plan_step_index(existing: list[dict[str, str]]) -> int:
    m = 0
    for s in existing:
        sid = str(s.get('id') or '')
        if sid.startswith('step-') and sid[5:].isdigit():
            m = max(m, int(sid[5:]))
    return m + 1


def _auto_remediation_step_text_from_final_review(review_result: str) -> str:
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


def _normalize_plan_steps_raw_text(plan_steps: str) -> str:
    """Turn inline numbered items into separate lines so each becomes its own checklist step."""
    text = (plan_steps or '').replace('\r\n', '\n').strip()
    if not text:
        return text
    return _INLINE_LIST_MARKER_BOUNDARY.sub('\n', text)


def _parse_plan_steps(plan_steps: str, *, existing_steps: list[dict[str, str]] | None = None) -> list[dict[str, str]]:
    steps: list[dict[str, str]] = []
    start = _next_plan_step_index(existing_steps) if existing_steps else 1
    for line in _normalize_plan_steps_raw_text(plan_steps).splitlines():
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


def _validate_initial_plan_steps(
    parsed_steps: list[dict[str, str]],
    profile: _TaskComplexityProfile,
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
    # One-step slack: complexity is a hint; models often produce enough work split across N-1 concrete steps.
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


def _validate_append_plan_steps(parsed_steps: list[dict[str, str]], profile: _TaskComplexityProfile) -> str | None:
    if not parsed_steps:
        return 'Tool error: plan_steps must contain at least one numbered or bulleted item.'
    if len(parsed_steps) > profile.max_steps:
        return (
            f'Tool error: add at most {profile.max_steps} remediation steps at a time. '
            'Split work across multiple append passes if needed.'
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
                'Tool error: appended checklist items must be build steps only. '
                'Do not include read/search/list/inspect/review/open actions as plan steps.'
            )
    return None


def _validate_probe_plan_steps(parsed_steps: list[dict[str, str]]) -> str | None:
    """Validate probed plan before fast path or escalation (no complexity floor)."""
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


def _compose_fast_path_step_instruction(task_summary: str, step_text: str) -> str:
    return (
        f'{routing_handoff_contract()}\n\n'
        f'**Original plan_and_modify task summary:**\n{(task_summary or "").strip()}\n\n'
        f'**Recorded plan step (execute this now):**\n{(step_text or "").strip()}\n\n'
        'If **Operation:** / **Paths:** / **Existence:** are not explicit above, derive them from the task and step '
        'before the nested router acts.'
    )


def _planner_progress_snapshot(
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
    return payload


def _select_step_for_execution(
    steps: list[dict[str, str]],
    step_instruction: str,
) -> dict[str, str] | None:
    del step_instruction  # Step execution is strictly driven by recorded checklist order.
    for step in steps:
        if step.get('state') != 'complete':
            return step
    return None


def _planner_has_incomplete_work(initial_plan_recorded: bool, steps: list[dict[str, str]]) -> bool:
    if not initial_plan_recorded:
        return True
    return any(step.get('state') != 'complete' for step in steps)


def _planner_should_reflect_for_final_review(
    initial_plan_recorded: bool,
    steps: list[dict[str, str]],
    *,
    final_review_state: str,
) -> bool:
    return initial_plan_recorded and _all_recorded_steps_complete(steps) and final_review_state == 'pending'


def _planner_needs_python_env_bootstrap(session: SessionState) -> bool:
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


def _next_incomplete_step_text(steps: list[dict[str, str]]) -> str:
    for step in steps:
        if step.get('state') != 'complete':
            return str(step.get('text') or '').strip()
    return ''


def _planner_terminal_phase(steps: list[dict[str, str]]) -> str:
    if not steps:
        return 'discovery'
    if any(step.get('state') == 'error' for step in steps):
        return 'error'
    if any(step.get('state') in {'pending', 'running'} for step in steps):
        return 'executing'
    return 'complete'


def _planner_terminal_phase_with_review(steps: list[dict[str, str]], *, final_review_state: str) -> str:
    base = _planner_terminal_phase(steps)
    if base in {'discovery', 'executing', 'error'}:
        return base
    if final_review_state == 'error':
        return 'error'
    if final_review_state != 'complete':
        return 'executing'
    return 'complete'


def _all_recorded_steps_complete(steps: list[dict[str, str]]) -> bool:
    return bool(steps) and all(step.get('state') == 'complete' for step in steps)


def _format_plan_steps_for_review(steps: list[dict[str, str]]) -> str:
    return '\n'.join(f'- {str(step.get("text") or "").strip()}' for step in steps if str(step.get('text') or '').strip())


def _build_final_project_review_instruction(task_summary: str, steps: list[dict[str, str]]) -> str:
    recorded_steps = _format_plan_steps_for_review(steps) or '- (no recorded steps)'
    return (
        'Run the final project review for this completed task.\n\n'
        f'Original task summary:\n{task_summary.strip() or "(empty task summary)"}\n\n'
        'Recorded implementation steps:\n'
        f'{recorded_steps}\n\n'
        'Review the current workspace as a whole. For Python work, ensure the workspace virtual environment exists, '
        'use dependency tools to repair/install packages when needed, run a smoke test when there is an obvious app '
        'entrypoint, and run workspace pytest only when the workspace or task provides a real pytest signal.'
    )


def _project_review_reentry_payload(request: ProjectReviewReentryRequest | None) -> dict[str, Any] | None:
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


async def _run_plan_probe_llm(task_summary: str) -> list[str] | None:
    """Return 1–6 build step strings, or None if the probe cannot run."""
    cleaned = (task_summary or '').strip() or '(empty task summary)'
    try:
        llm = build_llm()
    except Exception:
        logger.exception('plan probe: failed to build LLM')
        return None
    probe_prompt = (
        'You classify an implementation plan for a software workspace task.\n'
        'Return ONLY concrete build/mutation/verification steps (not read/search/list/inspect steps).\n'
        'Be honest about how many steps are needed: if the task truly needs four or more distinct build steps, '
        'list all of them (up to six). If it needs fewer, list only those.\n'
        'Each step must be a short imperative line (edit file X, add test Y, run Z).\n\n'
        f'Task:\n{cleaned}'
    )
    try:
        structured = llm.with_structured_output(_PlanProbeSteps)
        out = await structured.ainvoke([HumanMessage(content=probe_prompt)])
    except Exception:
        logger.exception('plan probe: structured invoke failed')
        return None
    if not isinstance(out, _PlanProbeSteps):
        return None
    steps = [s.strip() for s in out.steps if isinstance(s, str) and s.strip()]
    return steps or None


class _StepProxyQueue:
    """Proxy that forwards ``(tag, event)`` tuples to *outer_q* but swallows ``NESTED_WORKER_STREAM_END``.

    Each ``execute_plan_step`` call runs ``run_planning_nested_stream`` which puts
    ``NESTED_WORKER_STREAM_END`` when it finishes. That sentinel must not reach the
    outer SSE loop (which would prematurely signal the middleware done-event and clear
    nested stream state). Only the planner's own ``finally`` block should emit the
    sentinel on the real outer queue.
    """

    def __init__(self, outer_q: asyncio.Queue) -> None:
        self._outer_q = outer_q

    async def put(self, item: Any) -> None:
        if item is NESTED_WORKER_STREAM_END:
            return
        await self._outer_q.put(item)


async def run_coding_planner_fast_path_stream(
    session: SessionState,
    session_id: str,
    task_summary: str,
    planner_steps: list[dict[str, str]],
    nested_q: Any,
    checkpointer: Any,
) -> str:
    """Run probed 1–3 steps via ``run_planning_nested_stream`` each, then final project review (no planner graph)."""
    logger.info(
        'Coding planner fast path — steps=%d task_summary_length=%d',
        len(planner_steps),
        len(task_summary),
    )
    last_final_text = ''
    session.pending_project_review_reentry = None
    planner_tag = 'planner'
    final_review_state = 'pending'
    final_review_attempts = 0
    final_review_summary = ''

    if _planner_needs_python_env_bootstrap(session):
        bootstrap_result = await ensure_session_python_workspace_env(
            session,
            allow_workspace_root_fallback=False,
            bootstrap_dependencies=True,
        )
        if bootstrap_result is None:
            await nested_q.put(NESTED_WORKER_STREAM_END)
            return (
                'Tool error: the coding planner requires a workspace Python environment for this project, '
                'but no Python workspace could be resolved.'
            )
        if not bootstrap_result.ok:
            await nested_q.put(NESTED_WORKER_STREAM_END)
            return (
                'Tool error: the coding planner could not initialize the workspace Python environment before '
                'planning began.\n\n'
                f'{bootstrap_result.summary}'
            )

    step_proxy_q = _StepProxyQueue(nested_q)

    async def _emit_fp_progress(
        *,
        phase: str,
        active_step_id: str = '',
    ) -> None:
        try:
            final_review_max_attempts = max(0, int(get_active_connection().plan_retry_attempts_count))
        except Exception:
            final_review_max_attempts = 0
        await _enqueue_planner_progress(
            nested_q,
            planner_tag,
            _planner_progress_snapshot(
                planner_steps,
                phase,
                active_step_id=active_step_id,
                plan_ready=True,
                final_review_state=final_review_state,
                final_review_attempts=final_review_attempts,
                final_review_max_attempts=final_review_max_attempts,
                final_review_summary=final_review_summary,
                project_review_reentry=_project_review_reentry_payload(session.pending_project_review_reentry),
            ),
        )

    try:
        with _suppress_parent_graph_model_token_sse(session):
            await _emit_fp_progress(phase='discovery')
            plan_lines = '\n'.join(
                f'{i + 1}. {str(step.get("text") or "").strip()}' for i, step in enumerate(planner_steps)
            )
            await enqueue_plan_and_modify_outer_brief(
                session_id,
                nested_q,
                kind='plan_recorded',
                summary=plan_lines,
            )
            await _emit_fp_progress(phase='planning')

            for step in planner_steps:
                if session.abort_event.is_set():
                    last_final_text = 'Aborted by user.'
                    break
                sid = str(step.get('id') or '')
                step['state'] = 'running'
                await _emit_fp_progress(phase='executing', active_step_id=sid)
                instruction = _compose_fast_path_step_instruction(
                    task_summary,
                    str(step.get('text') or ''),
                )
                try:
                    step_result = await run_planning_nested_stream(
                        session,
                        session_id,
                        instruction,
                        step_proxy_q,
                        checkpointer,
                    )
                except Exception:
                    step['state'] = 'error'
                    await _emit_fp_progress(phase='error', active_step_id=sid)
                    raise
                truncated = _truncate_step_result(step_result)
                lowered = step_result.lower()
                if lowered.startswith('aborted by user') or lowered.startswith('tool error:'):
                    step['state'] = 'error'
                    await _emit_fp_progress(phase='error', active_step_id=sid)
                    last_final_text = truncated
                    break
                step['state'] = 'complete'
                await _emit_fp_progress(phase='executing')

            if not last_final_text and session.abort_event.is_set():
                last_final_text = 'Aborted by user.'
            elif (
                not last_final_text
                and planner_steps
                and all(step.get('state') == 'complete' for step in planner_steps)
            ):
                final_review_state = 'running'
                final_review_summary = ''
                await _emit_fp_progress(phase='executing')
                base_instruction = _build_final_project_review_instruction(task_summary, planner_steps)
                review_result = await run_final_project_review_stream(
                    session,
                    session_id,
                    base_instruction,
                    step_proxy_q,
                    checkpointer,
                )
                final_review_summary = review_result
                if not review_result.lower().startswith(_FINAL_PROJECT_REVIEW_FAILURE_PREFIX.lower()):
                    final_review_state = 'complete'
                    last_final_text = review_result
                else:
                    final_review_state = 'error'
                    final_review_attempts = 1
                    last_final_text = (
                        f'{review_result}\n\n'
                        'Fast path: final project review failed. Re-run `plan_and_modify` with a broader task '
                        'summary or enable the full planner path for automatic remediation steps.'
                    )
    except Exception:
        logger.exception('Coding planner fast path failed')
        raise
    finally:
        await _enqueue_planner_progress(
            nested_q,
            planner_tag,
            _planner_progress_snapshot(
                planner_steps,
                _planner_terminal_phase_with_review(
                    planner_steps,
                    final_review_state=final_review_state,
                ),
                plan_ready=True,
                final_review_state=final_review_state,
                final_review_attempts=final_review_attempts,
                final_review_max_attempts=max(0, int(get_active_connection().plan_retry_attempts_count)),
                final_review_summary=final_review_summary,
                project_review_reentry=_project_review_reentry_payload(session.pending_project_review_reentry),
            ),
        )
        await nested_q.put(NESTED_WORKER_STREAM_END)

    if not last_final_text.strip():
        last_final_text = (
            'The coding planner fast path finished without a final summary. Try rephrasing the task '
            'or use the full planner.'
        )
    return last_final_text


async def run_coding_planner_stream(
    session: SessionState,
    session_id: str,
    task_summary: str,
    nested_q: Any,
    checkpointer: Any,
    *,
    include_lsp_discovery: bool = True,
) -> str:
    """Run the coding planner agent; enqueue LangGraph v2 events, then ``NESTED_WORKER_STREAM_END``.

    The planner reads workspace files, builds a plan, then calls ``execute_plan_step``
    for each step (which delegates to ``run_planning_nested_stream`` -- the existing
    router/specialists pipeline).
    """
    logger.info(
        'Coding planner starting — task_summary length=%d include_lsp_discovery=%s',
        len(task_summary),
        include_lsp_discovery,
    )
    last_final_text = ''
    session.pending_project_review_reentry = None
    if _planner_needs_python_env_bootstrap(session):
        bootstrap_result = await ensure_session_python_workspace_env(
            session,
            allow_workspace_root_fallback=False,
            bootstrap_dependencies=True,
        )
        if bootstrap_result is None:
            await nested_q.put(NESTED_WORKER_STREAM_END)
            return (
                'Tool error: the coding planner requires a workspace Python environment for this project, '
                'but no Python workspace could be resolved.'
            )
        if not bootstrap_result.ok:
            await nested_q.put(NESTED_WORKER_STREAM_END)
            return (
                'Tool error: the coding planner could not initialize the workspace Python environment before '
                'planning began.\n\n'
                f'{bootstrap_result.summary}'
            )
    try:
        llm = build_llm()
    except Exception:
        logger.exception('Coding planner failed to build LLM')
        await nested_q.put(NESTED_WORKER_STREAM_END)
        raise

    step_proxy_q = _StepProxyQueue(nested_q)
    complexity_profile = _task_complexity_profile(task_summary)

    with _suppress_parent_graph_model_token_sse(session):
        initial_plan_recorded = False
        planner_tag = 'planner'
        planner_steps: list[dict[str, str]] = []
        planner_phase = 'discovery'
        discovery_tool_calls = 0
        final_review_state = 'pending'
        final_review_attempts = 0
        final_review_summary = ''
        latest_step_feedback = ''

        async def _emit_planner_progress(*, phase: str | None = None, active_step_id: str = '') -> None:
            nonlocal planner_phase
            if phase is not None:
                planner_phase = phase
            try:
                final_review_max_attempts = max(0, int(get_active_connection().plan_retry_attempts_count))
            except Exception:
                final_review_max_attempts = 0
            await _enqueue_planner_progress(
                nested_q,
                planner_tag,
                _planner_progress_snapshot(
                    planner_steps,
                    planner_phase,
                    active_step_id=active_step_id,
                    plan_ready=initial_plan_recorded,
                    final_review_state=final_review_state,
                    final_review_attempts=final_review_attempts,
                    final_review_max_attempts=final_review_max_attempts,
                    final_review_summary=final_review_summary,
                    project_review_reentry=_project_review_reentry_payload(session.pending_project_review_reentry),
                ),
            )

        def _execution_guard() -> str | None:
            if initial_plan_recorded:
                return None
            return 'Tool error: finish discovery and call `record_plan` before executing build steps.'

        def _final_review_guard() -> str | None:
            if not initial_plan_recorded:
                return 'Tool error: finish discovery and call `record_plan` before final project review.'
            if not _all_recorded_steps_complete(planner_steps):
                return 'Tool error: finish every recorded step before `run_final_project_review`.'
            if final_review_state == 'complete':
                return 'Tool error: final project review already passed for this task.'
            if final_review_state == 'running':
                return 'Tool error: final project review is already running.'
            if final_review_state == 'error':
                return (
                    'Tool error: final project review failed on a prior planner checkpoint. Call `record_plan` '
                    'with remediation build steps, complete them with `execute_plan_step`, then call '
                    '`run_final_project_review` again.'
                )
            return None

        async def _record_discovery_tool_use() -> None:
            nonlocal discovery_tool_calls
            discovery_tool_calls += 1
            if not initial_plan_recorded:
                await _emit_planner_progress(phase='discovery')

        @tool
        async def record_plan(plan_steps: str) -> str:
            """Record build steps after discovery, append after a failed final review, or a new phase after review passed."""
            nonlocal initial_plan_recorded, final_review_state, final_review_summary, final_review_attempts, latest_step_feedback
            if session.abort_event.is_set():
                return 'Aborted by user.'
            followup_phase = initial_plan_recorded and final_review_state == 'complete'
            remediation_phase = initial_plan_recorded and final_review_state == 'error'
            if initial_plan_recorded and not followup_phase and not remediation_phase:
                next_step = _next_incomplete_step_text(planner_steps)
                if next_step:
                    next_action_hint = (
                        f' Your next tool call should be `execute_plan_step` for this recorded step: "{next_step}".'
                    )
                elif _all_recorded_steps_complete(planner_steps) and final_review_state == 'pending':
                    next_action_hint = ' Your next tool call should be `run_final_project_review`.'
                else:
                    next_action_hint = (
                        ' Do not call `record_plan` again until final project review completes for this phase.'
                    )
                return (
                    'Tool error: the build checklist is already recorded for this phase and is locked until '
                    'final project review completes.'
                    f'{next_action_hint}'
                )
            cleaned = (plan_steps or '').strip()
            if not cleaned:
                return 'Tool error: plan_steps must not be empty.'
            if remediation_phase:
                parsed_append = _parse_plan_steps(cleaned, existing_steps=planner_steps)
                append_error = _validate_append_plan_steps(parsed_append, complexity_profile)
                if append_error:
                    return append_error
                line_append = len([line for line in cleaned.splitlines() if line.strip()])
                planner_steps.extend(parsed_append)
                final_review_state = 'pending'
                final_review_attempts = 0
                final_review_summary = ''
                latest_step_feedback = ''
                session.pending_project_review_reentry = None
                await _emit_planner_progress(phase='planning')
                plan_lines = '\n'.join(
                    f'{i + 1}. {str(step.get("text") or "").strip()}' for i, step in enumerate(planner_steps)
                )
                await enqueue_plan_and_modify_outer_brief(
                    session_id,
                    nested_q,
                    kind='plan_extended_after_review',
                    summary=plan_lines,
                )
                logger.info(
                    'Coding planner appended remediation steps after failed final review - new_step_lines=%d',
                    line_append,
                )
                return (
                    'Remediation steps appended after the failed final review. Execute each new step with '
                    '`execute_plan_step`, then call `run_final_project_review` again when every recorded step is complete.'
                )

            parsed_steps = _parse_plan_steps(cleaned)
            discovery_completed = discovery_tool_calls > 0 or followup_phase
            initial_requires_discovery = complexity_profile.requires_discovery or (
                NEMO_PLANNER_REQUIRE_DISCOVERY_FOR_CODE_PATHS
                and scope_text_mentions_programming_paths(task_summary)
            )
            validation_error = _validate_initial_plan_steps(
                parsed_steps,
                complexity_profile,
                discovery_completed=discovery_completed,
                requires_discovery=initial_requires_discovery,
            )
            if validation_error:
                return validation_error
            line_count = len([line for line in cleaned.splitlines() if line.strip()])
            planner_steps.clear()
            planner_steps.extend(parsed_steps)
            initial_plan_recorded = True
            final_review_state = 'pending'
            final_review_attempts = 0
            final_review_summary = ''
            latest_step_feedback = ''
            await _emit_planner_progress(phase='planning')
            plan_lines = '\n'.join(
                f'{i + 1}. {str(step.get("text") or "").strip()}' for i, step in enumerate(planner_steps)
            )
            await enqueue_plan_and_modify_outer_brief(
                session_id,
                nested_q,
                kind='plan_recorded',
                summary=plan_lines,
            )
            if followup_phase:
                logger.info(
                    'Coding planner recorded follow-up plan after final review - steps_text_lines=%d target_steps=%d',
                    line_count,
                    complexity_profile.target_steps,
                )
            else:
                logger.info(
                    'Coding planner recorded initial plan - steps_text_lines=%d target_steps=%d complexity_score=%d',
                    line_count,
                    complexity_profile.target_steps,
                    complexity_profile.score,
                )
            if followup_phase:
                return (
                    'Follow-up build checklist recorded. Execute the new steps with `execute_plan_step`, '
                    'then call `run_final_project_review` again when every new step is complete.'
                )
            return (
                'Initial build checklist recorded. Discovery is complete; execute the build steps with '
                '`execute_plan_step`.'
            )

        @tool(list_workspace_directory.name)
        async def planner_list_workspace_directory(relative_path: str = '.') -> str:
            """List files and folders during discovery or a narrowly scoped retry follow-up."""
            await _record_discovery_tool_use()
            result = list_workspace_directory.invoke({'relative_path': relative_path})
            return result + _planner_follow_up_context_note(initial_plan_recorded, final_review_state)

        @tool(read_workspace_file.name)
        async def planner_read_workspace_file(
            relative_path: str,
            start_line: int = 1,
            end_line: int = 220,
            include_line_numbers: bool = True,
            encoding: str = '',
        ) -> str:
            """Read a workspace file during discovery or a narrowly scoped retry follow-up."""
            await _record_discovery_tool_use()
            result = read_workspace_file.invoke(
                {
                    'relative_path': relative_path,
                    'start_line': start_line,
                    'end_line': end_line,
                    'include_line_numbers': include_line_numbers,
                    'encoding': encoding,
                }
            )
            return result + _planner_follow_up_context_note(initial_plan_recorded, final_review_state)

        @tool(search_workspace.name)
        async def planner_search_workspace(query: str, max_matches: int = 20, encoding: str = '') -> str:
            """Search the workspace during discovery or a narrowly scoped retry follow-up."""
            await _record_discovery_tool_use()
            result = search_workspace.invoke(
                {
                    'query': query,
                    'max_matches': max_matches,
                    'encoding': encoding,
                }
            )
            return result + _planner_follow_up_context_note(initial_plan_recorded, final_review_state)

        @tool(lsp_get_diagnostics.name)
        async def planner_lsp_get_diagnostics(
            relative_path: str = '',
            refresh_from_workspace: bool = False,
            encoding: str = '',
        ) -> str:
            """Inspect Python diagnostics through the active LSP session during discovery."""
            await _record_discovery_tool_use()
            result = lsp_get_diagnostics.invoke(
                {
                    'relative_path': relative_path,
                    'refresh_from_workspace': refresh_from_workspace,
                    'encoding': encoding,
                }
            )
            return result + _planner_follow_up_context_note(initial_plan_recorded, final_review_state)

        @tool(lsp_hover.name)
        async def planner_lsp_hover(relative_path: str, line: int, character: int) -> str:
            """Inspect Python symbol details with LSP hover during discovery."""
            await _record_discovery_tool_use()
            result = lsp_hover.invoke({'relative_path': relative_path, 'line': line, 'character': character})
            return result + _planner_follow_up_context_note(initial_plan_recorded, final_review_state)

        @tool(lsp_find_definition.name)
        async def planner_lsp_find_definition(relative_path: str, line: int, character: int) -> str:
            """Jump to Python definitions with LSP during discovery."""
            await _record_discovery_tool_use()
            result = lsp_find_definition.invoke({'relative_path': relative_path, 'line': line, 'character': character})
            return result + _planner_follow_up_context_note(initial_plan_recorded, final_review_state)

        @tool(lsp_find_references.name)
        async def planner_lsp_find_references(
            relative_path: str,
            line: int,
            character: int,
            include_declaration: bool = False,
        ) -> str:
            """Inspect Python references with LSP during discovery."""
            await _record_discovery_tool_use()
            result = lsp_find_references.invoke(
                {
                    'relative_path': relative_path,
                    'line': line,
                    'character': character,
                    'include_declaration': include_declaration,
                }
            )
            return result + _planner_follow_up_context_note(initial_plan_recorded, final_review_state)

        @tool(lsp_get_document_symbols.name)
        async def planner_lsp_get_document_symbols(relative_path: str) -> str:
            """Inspect Python document structure with LSP during discovery."""
            await _record_discovery_tool_use()
            result = lsp_get_document_symbols.invoke({'relative_path': relative_path})
            return result + _planner_follow_up_context_note(initial_plan_recorded, final_review_state)

        @tool
        async def execute_plan_step(step_instruction: str) -> str:
            """Execute a single mutation step via the workspace router and specialists.

            Pass a clear ``step_instruction`` describing what the step should accomplish:
            goal, target file path(s), and any relevant code context or constraints.
            """
            nonlocal final_review_state, final_review_summary, latest_step_feedback
            if session.abort_event.is_set():
                return 'Aborted by user.'
            blocked = _execution_guard()
            if blocked:
                return blocked
            step = _select_step_for_execution(planner_steps, step_instruction)
            if step is None:
                extra = ''
                if final_review_state == 'complete':
                    extra = (
                        ' If more implementation is needed, call `record_plan` again with new build-only steps '
                        'for the next phase, then continue with `execute_plan_step`.'
                    )
                elif initial_plan_recorded and _all_recorded_steps_complete(planner_steps):
                    extra = (
                        ' If every recorded step is complete, call `run_final_project_review` next (or `record_plan` '
                        'again only after final review has passed, if the task needs another implementation phase).'
                    )
                return (
                    'Tool error: there is no pending planned step to execute.'
                    + extra
                )
            step['state'] = 'running'
            await _emit_planner_progress(phase='executing', active_step_id=step['id'])
            try:
                step_result = await run_planning_nested_stream(
                    session,
                    session_id,
                    step_instruction,
                    step_proxy_q,
                    checkpointer,
                )
            except Exception:
                step['state'] = 'error'
                await _emit_planner_progress(phase='error', active_step_id=step['id'])
                raise
            truncated_result = _truncate_step_result(step_result)
            lowered = step_result.lower()
            if lowered.startswith('aborted by user') or lowered.startswith('tool error:'):
                step['state'] = 'error'
                latest_step_feedback = truncated_result
                await _emit_planner_progress(phase='error', active_step_id=step['id'])
            else:
                step['state'] = 'complete'
                final_review_state = 'pending'
                final_review_summary = ''
                latest_step_feedback = ''
                await _emit_planner_progress(phase='executing')
            return truncated_result

        @tool
        async def run_final_project_review(review_instruction: str = '') -> str:
            """Run the final project reviewer after the recorded implementation checklist is complete."""

            nonlocal final_review_attempts, final_review_state, final_review_summary
            if session.abort_event.is_set():
                return 'Aborted by user.'
            blocked = _final_review_guard()
            if blocked:
                return blocked
            base_instruction = (
                review_instruction.strip()
                or _build_final_project_review_instruction(task_summary, planner_steps)
            )
            final_review_state = 'running'
            final_review_summary = ''
            await _emit_planner_progress(phase='executing')
            review_result = await run_final_project_review_stream(
                session,
                session_id,
                base_instruction,
                step_proxy_q,
                checkpointer,
            )
            final_review_summary = review_result
            if not review_result.lower().startswith(_FINAL_PROJECT_REVIEW_FAILURE_PREFIX.lower()):
                final_review_state = 'complete'
                session.pending_project_review_reentry = None
                await _emit_planner_progress(phase='executing')
                return review_result

            final_review_attempts = 1
            session.pending_project_review_reentry = None
            new_idx = _next_plan_step_index(planner_steps)
            planner_steps.append(
                {
                    'id': f'step-{new_idx}',
                    'text': _auto_remediation_step_text_from_final_review(review_result),
                    'state': 'pending',
                }
            )
            final_review_state = 'pending'
            final_review_summary = 'Final project review failed; a remediation step was appended to the checklist.'
            plan_lines = '\n'.join(
                f'{i + 1}. {str(step.get("text") or "").strip()}' for i, step in enumerate(planner_steps)
            )
            await enqueue_plan_and_modify_outer_brief(
                session_id,
                nested_q,
                kind='plan_auto_remediation',
                summary=plan_lines,
            )
            await _emit_planner_progress(phase='planning')
            return (
                f'{review_result}\n\n'
                'Final project review failed. A remediation checklist step was appended automatically from the reviewer '
                'output. Run `execute_plan_step` for that new step, then call `run_final_project_review` again when '
                'every recorded step is complete. Do not call `record_plan` for this failure unless you need to split '
                'the remediation into multiple build steps.'
            )

        lsp_discovery_tools: list[Any] = [
            planner_lsp_get_diagnostics,
            planner_lsp_hover,
            planner_lsp_find_definition,
            planner_lsp_find_references,
            planner_lsp_get_document_symbols,
        ]
        planner_tools: list[Any] = [
            ensure_python_workspace_env_tool,
            record_plan,
            planner_list_workspace_directory,
            planner_read_workspace_file,
            planner_search_workspace,
            *(lsp_discovery_tools if include_lsp_discovery else []),
            *edit_tools_for_strict(runtime_config.tools.edit_tools_strict),
            execute_plan_step,
            run_final_project_review,
        ]

        system_prompt = build_coding_planner_system_prompt(
            session,
            include_lsp_discovery=include_lsp_discovery,
        )

        def _planner_should_retry_for_middleware() -> bool:
            if session.abort_event.is_set():
                return False
            return (
                _planner_has_incomplete_work(initial_plan_recorded, planner_steps)
                or _planner_should_reflect_for_final_review(
                    initial_plan_recorded,
                    planner_steps,
                    final_review_state=final_review_state,
                )
            )

        graph = create_agent(
            llm,
            planner_tools,
            system_prompt=system_prompt,
            name='nemo_coding_planner',
            middleware=[
                PlannerTaskRetryMiddleware(
                    should_retry=_planner_should_retry_for_middleware,
                    build_retry_prompt=lambda attempt: build_coding_planner_reflection_prompt(
                        reflection_attempt=attempt,
                        plan_ready=initial_plan_recorded,
                        steps=planner_steps,
                        next_step_text=_next_incomplete_step_text(planner_steps),
                        latest_feedback=latest_step_feedback or final_review_summary,
                        final_review_state=final_review_state,
                    ),
                    max_retries=NEMO_PLANNER_REFLECTION_RETRIES,
                ),
                EmptyResponseNudgeMiddleware(),
            ],
            checkpointer=checkpointer,
        )

        # Random suffix per plan_and_modify; isolates planner checkpoints between invocations.
        thread_id = f'{session_id}:coding_planner:{uuid.uuid4().hex[:10]}'
        config: RunnableConfig = {
            'configurable': {'thread_id': thread_id},
            'recursion_limit': MAX_AGENT_STEPS,
        }
        inputs: dict[str, Any] = {
            'messages': [
                HumanMessage(
                    content=build_coding_planner_task_prompt(
                        task_summary,
                        _plan_requirements_text(complexity_profile, task_summary),
                        include_lsp_discovery=include_lsp_discovery,
                    )
                )
            ],
        }

        try:
            await _emit_planner_progress(phase='discovery')
            async for ev in graph.astream_events(inputs, config, version='v2'):
                if session.abort_event.is_set():
                    break
                await _enqueue_planner_event(nested_q, planner_tag, ev)
                et = ev.get('event')
                data = ev.get('data') if isinstance(ev.get('data'), dict) else {}
                if et == 'on_chat_model_end':
                    raw = data.get('output')
                    msg = raw if isinstance(raw, AIMessage) else None
                    if msg is not None and not (msg.tool_calls or []):
                        last_final_text = final_assistant_text(msg)
        except Exception:
            logger.exception('Coding planner graph failed')
            raise
        finally:
            await _enqueue_planner_progress(
                nested_q,
                planner_tag,
                _planner_progress_snapshot(
                    planner_steps,
                    _planner_terminal_phase_with_review(
                        planner_steps,
                        final_review_state=final_review_state,
                    ),
                    plan_ready=initial_plan_recorded,
                    final_review_state=final_review_state,
                    final_review_attempts=final_review_attempts,
                    final_review_max_attempts=max(0, int(get_active_connection().plan_retry_attempts_count)),
                    final_review_summary=final_review_summary,
                    project_review_reentry=_project_review_reentry_payload(session.pending_project_review_reentry),
                ),
            )
            await nested_q.put(NESTED_WORKER_STREAM_END)

        if not last_final_text.strip():
            last_final_text = (
                'The coding planner finished without a final text response. '
                'Try rephrasing the task.'
            )
        return last_final_text


async def run_coding_planner_orchestrated_stream(
    session: SessionState,
    session_id: str,
    task_summary: str,
    nested_q: Any,
    checkpointer: Any,
) -> str:
    """Plan probe + fast path (1–3 steps) or full ``run_coding_planner_stream``; conditional LSP discovery tools."""
    complexity_profile = _task_complexity_profile(task_summary)
    include_lsp = scope_text_mentions_programming_paths(task_summary)

    if not NEMO_PLAN_PROBE_ENABLED:
        return await run_coding_planner_stream(
            session,
            session_id,
            task_summary,
            nested_q,
            checkpointer,
            include_lsp_discovery=include_lsp,
        )

    if complexity_profile.max_steps >= NEMO_PLAN_SKIP_PROBE_MIN_COMPLEXITY_MAX_STEPS:
        logger.info(
            'plan probe skipped — max_steps=%d >= NEMO_PLAN_SKIP_PROBE_MIN_COMPLEXITY_MAX_STEPS=%d',
            complexity_profile.max_steps,
            NEMO_PLAN_SKIP_PROBE_MIN_COMPLEXITY_MAX_STEPS,
        )
        return await run_coding_planner_stream(
            session,
            session_id,
            task_summary,
            nested_q,
            checkpointer,
            include_lsp_discovery=include_lsp,
        )

    raw_steps = await _run_plan_probe_llm(task_summary)
    if raw_steps is None:
        logger.info('plan probe unavailable — full coding planner')
        return await run_coding_planner_stream(
            session,
            session_id,
            task_summary,
            nested_q,
            checkpointer,
            include_lsp_discovery=include_lsp,
        )

    plan_blob = '\n'.join(f'{i + 1}. {t}' for i, t in enumerate(raw_steps))
    parsed = _parse_plan_steps(plan_blob)
    probe_err = _validate_probe_plan_steps(parsed)
    if probe_err:
        logger.info('plan probe invalid (%s) — full coding planner', probe_err)
        return await run_coding_planner_stream(
            session,
            session_id,
            task_summary,
            nested_q,
            checkpointer,
            include_lsp_discovery=include_lsp,
        )

    if len(parsed) >= 4:
        logger.info('plan probe returned %d steps — full coding planner', len(parsed))
        scope_lsp = scope_text_mentions_programming_paths(task_summary, *raw_steps)
        return await run_coding_planner_stream(
            session,
            session_id,
            task_summary,
            nested_q,
            checkpointer,
            include_lsp_discovery=scope_lsp,
        )

    if 1 <= len(parsed) <= NEMO_PLAN_FAST_PATH_MAX_STEPS:
        logger.info('plan probe fast path — %d step(s)', len(parsed))
        return await run_coding_planner_fast_path_stream(
            session,
            session_id,
            task_summary,
            parsed,
            nested_q,
            checkpointer,
        )

    return await run_coding_planner_stream(
        session,
        session_id,
        task_summary,
        nested_q,
        checkpointer,
        include_lsp_discovery=include_lsp,
    )
