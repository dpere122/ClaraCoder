"""Coding planner LangGraph agent: reads workspace, plans, then delegates steps to the router/specialists."""

from __future__ import annotations

import asyncio
import logging
import re
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

from langchain.agents import create_agent
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool

from nemo_backend.agents.coding_planner.prompts import (
    build_coding_planner_system_prompt,
    build_coding_planner_task_prompt,
)
from nemo_backend.agents.orchestration.nested_pipeline import (
    NESTED_WORKER_STREAM_END,
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
    NEMO_PLANNER_REQUEST_LARGE_CHARS,
    NEMO_PLANNER_REQUEST_MEDIUM_CHARS,
    NEMO_PLANNER_REQUEST_SMALL_CHARS,
    NEMO_PLANNER_STEP_RESULT_MAX_CHARS,
)
from nemo_backend.domain import SessionState
from nemo_backend.edit_staging import clear_session_staging_dir, discard_all_session_stagings
from nemo_backend.empty_response_middleware import EmptyResponseNudgeMiddleware
from nemo_backend.llm import build_llm
from nemo_backend.messages import final_assistant_text
from nemo_backend.workspace_tools import list_workspace_directory, read_workspace_file, search_workspace

logger = logging.getLogger('nemo.agent.langgraph.coding_planner')
_PLAN_STEP_RE = re.compile(r'^\s*(?:[-*]|\d+[.)])\s+(.*\S)\s*$')
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


def _plan_requirements_text(profile: _TaskComplexityProfile) -> str:
    lines = [
        f'- Request length: {profile.char_count} chars; computed complexity score: {profile.score}.',
        (
            f'- Record between {profile.min_steps} and {profile.max_steps} build steps; '
            f'aim for about {profile.target_steps}.'
        ),
        f'- Keep each recorded step under {NEMO_PLANNER_MAX_STEP_TEXT_CHARS} characters.',
        '- The checklist must contain only implementation/build/test/verification steps.',
    ]
    if profile.requires_discovery:
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


def _parse_plan_steps(plan_steps: str) -> list[dict[str, str]]:
    steps: list[dict[str, str]] = []
    for line in plan_steps.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        match = _PLAN_STEP_RE.match(line)
        text = (match.group(1) if match else stripped).strip()
        if not text:
            continue
        steps.append({'id': f'step-{len(steps) + 1}', 'text': text, 'state': 'pending'})
    return steps


def _validate_initial_plan_steps(
    parsed_steps: list[dict[str, str]],
    profile: _TaskComplexityProfile,
    *,
    discovery_completed: bool,
) -> str | None:
    if not parsed_steps:
        return 'Tool error: plan_steps must contain at least one numbered or bulleted item.'
    if profile.requires_discovery and not discovery_completed:
        return (
            'Tool error: gather missing workspace context with planner read/search/list tools before recording '
            'the build plan for this task.'
        )
    if len(parsed_steps) < profile.min_steps:
        return (
            f'Tool error: this task needs at least {profile.min_steps} concrete build steps based on its complexity. '
            'Do not record a single broad step.'
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


def _planner_progress_snapshot(
    steps: list[dict[str, str]],
    phase: str,
    *,
    active_step_id: str = '',
    plan_ready: bool = False,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        'streamTag': 'planner',
        'phase': phase,
        'planReady': plan_ready,
        'steps': [dict(step) for step in steps],
    }
    if active_step_id:
        payload['activeStepId'] = active_step_id
    return payload


def _select_step_for_execution(
    steps: list[dict[str, str]],
    step_instruction: str,
) -> dict[str, str] | None:
    for step in steps:
        if step.get('state') == 'pending':
            return step
    for step in steps:
        if step.get('state') == 'running':
            return step
    return None


def _planner_terminal_phase(steps: list[dict[str, str]]) -> str:
    if not steps:
        return 'discovery'
    if any(step.get('state') == 'error' for step in steps):
        return 'error'
    if any(step.get('state') in {'pending', 'running'} for step in steps):
        return 'executing'
    return 'complete'


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


async def run_coding_planner_stream(
    session: SessionState,
    session_id: str,
    task_summary: str,
    nested_q: Any,
    checkpointer: Any,
) -> str:
    """Run the coding planner agent; enqueue LangGraph v2 events, then ``NESTED_WORKER_STREAM_END``.

    The planner reads workspace files, builds a plan, then calls ``execute_plan_step``
    for each step (which delegates to ``run_planning_nested_stream`` -- the existing
    router/specialists pipeline).
    """
    logger.info('Coding planner starting — task_summary length=%d', len(task_summary))
    last_final_text = ''
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

        async def _emit_planner_progress(*, phase: str | None = None, active_step_id: str = '') -> None:
            nonlocal planner_phase
            if phase is not None:
                planner_phase = phase
            await _enqueue_planner_progress(
                nested_q,
                planner_tag,
                _planner_progress_snapshot(
                    planner_steps,
                    planner_phase,
                    active_step_id=active_step_id,
                    plan_ready=initial_plan_recorded,
                ),
            )

        def _execution_guard() -> str | None:
            if initial_plan_recorded:
                return None
            return 'Tool error: finish discovery and call `record_plan` before executing build steps.'

        def _discovery_guard() -> str | None:
            if not initial_plan_recorded:
                return None
            return 'Tool error: planner discovery reads must happen before `record_plan`. Keep the checklist build-only.'

        async def _record_discovery_tool_use() -> None:
            nonlocal discovery_tool_calls
            discovery_tool_calls += 1
            await _emit_planner_progress(phase='discovery')

        @tool
        async def record_plan(plan_steps: str) -> str:
            """Record the planner's initial numbered build-step list after discovery is complete."""
            nonlocal initial_plan_recorded
            if session.abort_event.is_set():
                return 'Aborted by user.'
            cleaned = (plan_steps or '').strip()
            if not cleaned:
                return 'Tool error: plan_steps must not be empty.'
            parsed_steps = _parse_plan_steps(cleaned)
            validation_error = _validate_initial_plan_steps(
                parsed_steps,
                complexity_profile,
                discovery_completed=discovery_tool_calls > 0,
            )
            if validation_error:
                return validation_error
            line_count = len([line for line in cleaned.splitlines() if line.strip()])
            planner_steps.clear()
            planner_steps.extend(parsed_steps)
            initial_plan_recorded = True
            await _emit_planner_progress(phase='planning')
            logger.info(
                'Coding planner recorded initial plan - steps_text_lines=%d target_steps=%d complexity_score=%d',
                line_count,
                complexity_profile.target_steps,
                complexity_profile.score,
            )
            return (
                'Initial build checklist recorded. Discovery is complete; execute the build steps with '
                '`execute_plan_step`.'
            )

        @tool(list_workspace_directory.name)
        async def planner_list_workspace_directory(relative_path: str = '.') -> str:
            """List files and folders during planner discovery, before the build checklist is recorded."""
            blocked = _discovery_guard()
            if blocked:
                return blocked
            await _record_discovery_tool_use()
            return list_workspace_directory.invoke({'relative_path': relative_path})

        @tool(read_workspace_file.name)
        async def planner_read_workspace_file(
            relative_path: str,
            start_line: int = 1,
            end_line: int = 220,
            include_line_numbers: bool = True,
            encoding: str = '',
        ) -> str:
            """Read a workspace file during planner discovery, before the build checklist is recorded."""
            blocked = _discovery_guard()
            if blocked:
                return blocked
            await _record_discovery_tool_use()
            return read_workspace_file.invoke(
                {
                    'relative_path': relative_path,
                    'start_line': start_line,
                    'end_line': end_line,
                    'include_line_numbers': include_line_numbers,
                    'encoding': encoding,
                }
            )

        @tool(search_workspace.name)
        async def planner_search_workspace(query: str, max_matches: int = 20, encoding: str = '') -> str:
            """Search the workspace during planner discovery, before the build checklist is recorded."""
            blocked = _discovery_guard()
            if blocked:
                return blocked
            await _record_discovery_tool_use()
            return search_workspace.invoke(
                {
                    'query': query,
                    'max_matches': max_matches,
                    'encoding': encoding,
                }
            )

        @tool
        async def execute_plan_step(step_instruction: str) -> str:
            """Execute a single mutation step via the workspace router and specialists.

            Pass a clear ``step_instruction`` describing what the step should accomplish:
            goal, target file path(s), and any relevant code context or constraints.
            """
            if session.abort_event.is_set():
                return 'Aborted by user.'
            blocked = _execution_guard()
            if blocked:
                return blocked
            step = _select_step_for_execution(planner_steps, step_instruction)
            if step is None:
                return (
                    'Tool error: there is no pending planned step to execute. '
                    'Update the plan with `record_plan` before executing more work.'
                )
            step['state'] = 'running'
            await _emit_planner_progress(phase='executing', active_step_id=step['id'])
            try:
                step_result = await run_planning_nested_stream(
                    session, session_id, step_instruction, step_proxy_q, checkpointer
                )
            except Exception:
                step['state'] = 'error'
                await _emit_planner_progress(phase='error', active_step_id=step['id'])
                raise
            truncated_result = _truncate_step_result(step_result)
            lowered = step_result.lower()
            if lowered.startswith('aborted by user') or lowered.startswith('tool error:'):
                step['state'] = 'error'
                await _emit_planner_progress(phase='error', active_step_id=step['id'])
            else:
                step['state'] = 'complete'
                await _emit_planner_progress(phase='executing')
            return truncated_result

        planner_tools: list[Any] = [
            record_plan,
            planner_list_workspace_directory,
            planner_read_workspace_file,
            planner_search_workspace,
            execute_plan_step,
        ]

        system_prompt = build_coding_planner_system_prompt(session)
        graph = create_agent(
            llm,
            planner_tools,
            system_prompt=system_prompt,
            name='nemo_coding_planner',
            middleware=[
                EmptyResponseNudgeMiddleware(),
            ],
            checkpointer=checkpointer,
        )

        thread_id = f'{session_id}:coding_planner:{uuid.uuid4().hex[:10]}'
        config: RunnableConfig = {
            'configurable': {'thread_id': thread_id},
            'recursion_limit': MAX_AGENT_STEPS,
        }
        inputs: dict[str, Any] = {
            'messages': [
                HumanMessage(
                    content=build_coding_planner_task_prompt(task_summary, _plan_requirements_text(complexity_profile))
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
            if session.pending_edit_stagings:
                logger.warning(
                    'Orphaned edit stagings after coding planner (discarding): %s',
                    list(session.pending_edit_stagings.keys()),
                )
                discard_all_session_stagings(session)
            clear_session_staging_dir(session_id)
            await _enqueue_planner_progress(
                nested_q,
                planner_tag,
                _planner_progress_snapshot(
                    planner_steps,
                    _planner_terminal_phase(planner_steps),
                    plan_ready=initial_plan_recorded,
                ),
            )
            await nested_q.put(NESTED_WORKER_STREAM_END)

        if not last_final_text.strip():
            last_final_text = (
                'The coding planner finished without a final text response. '
                'Try rephrasing the task.'
            )
        return last_final_text
