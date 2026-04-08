"""Single LangGraph router graph: handoff tools run specialist ``create_agent`` subgraphs (streaming to nested queue)."""

from __future__ import annotations

import logging
import uuid
from contextlib import contextmanager
from typing import Any

from langchain.agents import create_agent
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool

from nemo_backend.agents.specialists.prompts import (
    build_code_review_specialist_system_prompt,
    build_create_specialist_system_prompt,
    build_dependency_specialist_system_prompt,
    build_delete_specialist_system_prompt,
    build_project_review_specialist_system_prompt,
    build_router_system_prompt,
    build_update_specialist_system_prompt,
)
from nemo_backend.agents.specialists.project_review_tools import (
    APPROVE_PROJECT_REVIEW_NAME,
    REJECT_PROJECT_REVIEW_NAME,
    maybe_bootstrap_python_workspace_env_for_project_review,
    project_review_specialist_tools,
)
from nemo_backend.agents.specialists.review_tools import (
    REJECT_STAGED_WORKSPACE_EDIT_NAME,
    TRANSFER_STAGED_FILE_TO_WORKSPACE_NAME,
    code_review_specialist_tools,
)
from nemo_backend.agents.specialists.tools import (
    create_specialist_tools,
    dependency_specialist_tools,
    delete_specialist_tools,
    update_specialist_tools,
)
from nemo_backend.config import MAX_AGENT_STEPS
from nemo_backend.accept_command_review_middleware import AcceptCommandReviewAfterToolMiddleware
from nemo_backend.delete_review_middleware import DeleteReviewAfterToolMiddleware
from nemo_backend.diff_review_middleware import DiffReviewAfterToolMiddleware
from nemo_backend.empty_response_middleware import EmptyResponseNudgeMiddleware
from nemo_backend.domain import SessionState
from nemo_backend.llm import build_llm
from nemo_backend.lsp.manager import activate_session_lsp_scope
from nemo_backend.messages import final_assistant_text, stringify_content
from nemo_backend.parallel_tool_middleware import ConnectionParallelToolCallsMiddleware
from nemo_backend.state import get_active_connection, runtime_config

logger = logging.getLogger('nemo.agent.langgraph.planning')

NESTED_WORKER_STREAM_END = object()

_CODE_REVIEW_DECISION_TOOL_NAMES = frozenset(
    {TRANSFER_STAGED_FILE_TO_WORKSPACE_NAME, REJECT_STAGED_WORKSPACE_EDIT_NAME}
)
_PROJECT_REVIEW_DECISION_TOOL_NAMES = frozenset({APPROVE_PROJECT_REVIEW_NAME, REJECT_PROJECT_REVIEW_NAME})
_CODE_REVIEW_REJECTION_PREFIX = 'Tool error: code review rejected the current step.'
_CODE_REVIEW_DECISION_MISSING_PREFIX = 'Tool error: code review specialist finished without calling '


def _tool_output_text(raw: Any) -> str:
    if isinstance(raw, ToolMessage):
        return stringify_content(raw.content)
    if raw is None:
        return ''
    if isinstance(raw, str):
        return raw
    return str(raw)


def _is_probable_test_path(relative_path: str) -> bool:
    lowered = relative_path.strip().replace('\\', '/').lower()
    leaf = lowered.rsplit('/', 1)[-1]
    return '/tests/' in f'/{lowered}' or leaf.startswith('test_') or leaf.endswith('_test.py')


def _pending_code_review_paths(session: SessionState) -> list[str]:
    paths: list[str] = []
    for rel_key, entry in sorted(session.pending_edit_stagings.items()):
        value = getattr(entry, 'workspace_applied', False)
        if isinstance(value, bool) and value:
            continue
        paths.append(rel_key)
    return paths


def _pending_code_review_snapshot(session: SessionState, staged_paths: list[str]) -> dict[str, str]:
    pending = set(staged_paths)
    snapshot: dict[str, str] = {}
    for rel_key, entry in sorted(session.pending_edit_stagings.items()):
        if rel_key not in pending:
            continue
        value = getattr(entry, 'workspace_applied', False)
        if isinstance(value, bool) and value:
            continue
        snapshot[rel_key] = str(getattr(entry, 'merged_text', ''))
    return snapshot


def _build_code_review_instruction(session: SessionState, task_instruction: str) -> str:
    base = task_instruction.strip() or 'Review the staged changes and decide whether to transfer or reject.'
    staged_paths = _pending_code_review_paths(session)
    if not staged_paths:
        return base
    test_paths = [path for path in staged_paths if _is_probable_test_path(path)]
    lines = [base, '', 'Staged paths:']
    lines.extend(f'- `{path}`' for path in staged_paths)
    lines.extend(['', 'Related staged test files:'])
    if test_paths:
        lines.extend(f'- `{path}`' for path in test_paths)
    else:
        lines.append('- None identified in the current staged set.')
    return '\n'.join(lines)


def _build_auto_code_review_followup_instruction(
    mutation_kind: str,
    task_instruction: str,
    mutation_result: str,
) -> str:
    base = task_instruction.strip() or 'Review the staged changes and decide whether to transfer or reject.'
    kind_label = 'create' if mutation_kind == 'create' else 'update'
    summary = mutation_result.strip() or '(no specialist summary provided)'
    return (
        f'{base}\n\n'
        f'The {kind_label} specialist staged code for review and returned this summary:\n'
        f'{summary}\n\n'
        'Complete the staged review now. If the review rejects the draft, keep the fix inside the same current '
        'step and continue through the nested revision loop until the staged file transfers or a real tool failure occurs.'
    )


def _looks_like_staged_code_review_result(result_text: str) -> bool:
    lowered = result_text.lower()
    return (
        'for code review' in lowered
        or 'workspace file is not updated yet' in lowered
        or 'updated staged draft' in lowered
    )


def _build_code_review_retry_instruction(
    task_instruction: str,
    review_feedback: str,
    staged_paths: list[str],
    *,
    retry_attempt: int,
) -> str:
    base = task_instruction.strip() or 'Revise the staged implementation using reviewer feedback.'
    lines = [
        'The staged code review rejected the current implementation step.',
        '',
        f'Original step instruction:\n{base}',
        '',
        f'Code review revision round: {retry_attempt}',
        '',
        'Revise the existing staged draft only for these paths:',
    ]
    lines.extend(f'- `{path}`' for path in staged_paths)
    lines.extend(
        [
            '',
            'Reviewer feedback:',
            review_feedback.strip() or '(no feedback provided)',
            '',
            'Before you overwrite any file, call `read_staged_edit` for each staged path and use that staged draft as '
            'your baseline. Do not assume the workspace file on disk is newer than the staged draft.',
            '',
            'Keep the fix scoped to the same recorded step and existing staged draft. '
            'Do not create a new plan, do not broaden the task, and do not hand work back to the planner.',
        ]
    )
    return '\n'.join(lines)


def _build_code_review_force_decision_instruction(session: SessionState, task_instruction: str, prior_result: str) -> str:
    base = _build_code_review_instruction(session, task_instruction)
    prior = prior_result.strip()
    if prior:
        return (
            f'{base}\n\n'
            'Your previous review turn ended without calling the required decision tool. Use the staged draft as the '
            'source of truth, then finish this turn with exactly one of '
            '`transfer_staged_file_to_workspace` or `reject_staged_workspace_edit`.\n\n'
            f'Previous outcome:\n{prior}'
        )
    return (
        f'{base}\n\n'
        'Your previous review turn ended without calling the required decision tool. Use the staged draft as the '
        'source of truth, then finish this turn with exactly one of '
        '`transfer_staged_file_to_workspace` or `reject_staged_workspace_edit`.'
    )


@contextmanager
def _suppress_parent_graph_model_token_sse(session: SessionState):
    """Hide nested subgraph LLM tokens on the parent graph's ``astream_events`` queue (see ``SessionState``)."""
    session.suppress_parent_graph_model_token_sse = True
    try:
        yield
    finally:
        session.suppress_parent_graph_model_token_sse = False


async def _enqueue_nested_event(nested_q: Any, stream_tag: str, ev: dict[str, Any]) -> None:
    await nested_q.put((stream_tag, ev))


async def run_planning_nested_stream(
    session: SessionState,
    session_id: str,
    task_summary: str,
    nested_q: Any,
    checkpointer: Any,
    *,
    allow_project_review: bool = True,
) -> str:
    """Run nested planning router; enqueue LangGraph v2 events, then ``NESTED_WORKER_STREAM_END``."""
    last_final_text = ''
    edit_strict = runtime_config.tools.edit_tools_strict
    try:
        llm = build_llm()
    except Exception:
        await nested_q.put(NESTED_WORKER_STREAM_END)
        raise

    with _suppress_parent_graph_model_token_sse(session):
        async def _run_specialist_graph(kind: str, task_instruction: str) -> str:
            spec_llm = build_llm()
            if kind == 'code_review':
                activate_session_lsp_scope(session_id, scope='staging')
            if kind == 'create':
                tools, _ = create_specialist_tools()
                system_prompt = build_create_specialist_system_prompt(session)
            elif kind == 'update':
                tools, _ = update_specialist_tools(edit_strict)
                system_prompt = build_update_specialist_system_prompt(session)
            elif kind == 'delete':
                tools, _ = delete_specialist_tools()
                system_prompt = build_delete_specialist_system_prompt(session)
            elif kind == 'dependency':
                tools, _ = dependency_specialist_tools()
                system_prompt = build_dependency_specialist_system_prompt(session)
            elif kind == 'code_review':
                tools, _ = code_review_specialist_tools()
                system_prompt = build_code_review_specialist_system_prompt(session)
            elif kind == 'project_review':
                tools, _ = project_review_specialist_tools()
                system_prompt = build_project_review_specialist_system_prompt(session)
            else:
                return f'Unknown specialist kind: {kind}'

            sub = create_agent(
                spec_llm,
                tools,
                system_prompt=system_prompt,
                name=f'nemo_specialist_{kind}',
                middleware=[
                    ConnectionParallelToolCallsMiddleware(),
                    EmptyResponseNudgeMiddleware(),
                    AcceptCommandReviewAfterToolMiddleware(),
                    DiffReviewAfterToolMiddleware(),
                    DeleteReviewAfterToolMiddleware(),
                ],
                checkpointer=checkpointer,
            )
            thread_id = f'{session_id}:spec:{kind}:{uuid.uuid4().hex[:10]}'
            config: RunnableConfig = {
                'configurable': {'thread_id': thread_id},
                'recursion_limit': MAX_AGENT_STEPS,
            }
            inputs: dict[str, Any] = {'messages': [HumanMessage(content=task_instruction.strip() or '(no instruction)')]}
            spec_final = ''
            spec_tag = f'spec-{kind}-{uuid.uuid4().hex[:8]}'
            review_decision_made = False
            review_decision_tool = ''
            review_decision_result = ''
            project_review_decision_made = False
            project_review_decision_tool = ''
            project_review_decision_result = ''
            try:
                async for ev in sub.astream_events(inputs, config, version='v2'):
                    await _enqueue_nested_event(nested_q, spec_tag, ev)
                    et = ev.get('event')
                    data = ev.get('data') if isinstance(ev.get('data'), dict) else {}
                    if et == 'on_tool_end' and kind == 'code_review':
                        tool_name = str(ev.get('name') or '')
                        if tool_name in _CODE_REVIEW_DECISION_TOOL_NAMES:
                            tool_result = _tool_output_text(data.get('output')).strip()
                            if not tool_result.lower().startswith('tool error:'):
                                review_decision_made = True
                                review_decision_tool = tool_name
                                review_decision_result = tool_result
                    if et == 'on_tool_end' and kind == 'project_review':
                        tool_name = str(ev.get('name') or '')
                        if tool_name in _PROJECT_REVIEW_DECISION_TOOL_NAMES:
                            tool_result = _tool_output_text(data.get('output')).strip()
                            if not tool_result.lower().startswith('tool error:'):
                                project_review_decision_made = True
                                project_review_decision_tool = tool_name
                                project_review_decision_result = tool_result
                    if et == 'on_chat_model_end':
                        raw = data.get('output')
                        msg = raw if isinstance(raw, AIMessage) else None
                        if msg is not None and not (msg.tool_calls or []):
                            spec_final = final_assistant_text(msg)
            except Exception:
                logger.exception('Specialist graph failed (%s)', kind)
                raise
            if kind == 'code_review' and not review_decision_made:
                pending = sorted(session.pending_edit_stagings.keys())
                if pending:
                    pending_detail = f' Pending staged edits: {", ".join(f"`{path}`" for path in pending)}.'
                else:
                    pending_detail = ''
                logger.warning(
                    'Code review specialist finished without transfer/reject; final_text=%r pending=%s',
                    spec_final[:240],
                    pending,
                )
                return (
                    _CODE_REVIEW_DECISION_MISSING_PREFIX
                    + '`transfer_staged_file_to_workspace` or `reject_staged_workspace_edit`.'
                    f' Review summary: {spec_final.strip() or "(no final text provided)"}'
                    f'{pending_detail}'
                )
            if kind == 'code_review' and review_decision_tool == REJECT_STAGED_WORKSPACE_EDIT_NAME:
                return (
                    'Tool error: code review rejected the current step. Retry the same recorded step with only the '
                    'minimum in-scope fixes needed for approval; do not broaden the task or create a new plan.\n\n'
                    f'{review_decision_result or spec_final.strip()}'
                )
            if kind == 'project_review' and not project_review_decision_made:
                logger.warning(
                    'Project review specialist finished without approval or rejection; final_text=%r',
                    spec_final[:240],
                )
                return (
                    'Tool error: project review specialist finished without calling '
                    '`approve_project_review` or `reject_project_review`.'
                )
            if kind == 'project_review' and project_review_decision_tool == REJECT_PROJECT_REVIEW_NAME:
                return (
                    'Tool error: final project review failed. Use the reviewer feedback to make the minimum '
                    'workspace fixes needed for another final review pass.\n\n'
                    f'{project_review_decision_result or spec_final.strip()}'
                )
            return spec_final.strip() or f'Specialist `{kind}` finished without a final text response.'

        async def _run_mutation_specialist_with_auto_review(kind: str, task_instruction: str) -> str:
            pending_before = set(session.pending_edit_stagings.keys())
            mutation_result = await _run_specialist_graph(kind, task_instruction)
            lowered = mutation_result.lower()
            if lowered.startswith('aborted by user') or lowered.startswith('tool error:'):
                return mutation_result
            pending_after = set(session.pending_edit_stagings.keys())
            staged_now = pending_after - pending_before
            if not pending_after:
                return mutation_result
            if not staged_now and not _looks_like_staged_code_review_result(mutation_result):
                return mutation_result
            review_result = await route_code_review_specialist.ainvoke(
                {
                    'task_instruction': _build_auto_code_review_followup_instruction(
                        kind,
                        task_instruction,
                        mutation_result,
                    )
                }
            )
            if review_result.lower().startswith('aborted by user') or review_result.lower().startswith('tool error:'):
                return review_result
            if not mutation_result.strip():
                return review_result
            return f'{mutation_result}\n\nCode review outcome:\n{review_result}'

        @tool
        async def route_create_specialist(task_instruction: str) -> str:
            """Hand off new files or full-file writes to the create specialist."""
            return await _run_mutation_specialist_with_auto_review('create', task_instruction)

        @tool
        async def route_update_specialist(task_instruction: str) -> str:
            """Hand off edits to existing files to the update specialist."""
            return await _run_mutation_specialist_with_auto_review('update', task_instruction)

        @tool
        async def route_delete_specialist(task_instruction: str) -> str:
            """Hand off file or directory deletion to the delete specialist."""
            return await _run_specialist_graph('delete', task_instruction)

        @tool
        async def route_dependency_specialist(task_instruction: str) -> str:
            """Hand off Python dependency and manifest actions to the dependency specialist."""
            return await _run_specialist_graph('dependency', task_instruction)

        @tool
        async def route_code_review_specialist(task_instruction: str) -> str:
            """Hand off staged code edits to the code review specialist (read/search staging, approve or reject)."""
            retry_attempt = 0
            decision_retry_attempt = 0
            retry_limit = max(1, int(get_active_connection().plan_retry_attempts_count))
            prior_rejection = ''
            if not _pending_code_review_paths(session):
                return 'Tool error: no staged edits are currently awaiting code review.'
            review_result = await _run_specialist_graph('code_review', _build_code_review_instruction(session, task_instruction))
            while review_result.lower().startswith(_CODE_REVIEW_DECISION_MISSING_PREFIX.lower()):
                if decision_retry_attempt >= 1:
                    return review_result
                decision_retry_attempt += 1
                review_result = await _run_specialist_graph(
                    'code_review',
                    _build_code_review_force_decision_instruction(session, task_instruction, review_result),
                )
            while review_result.lower().startswith(_CODE_REVIEW_REJECTION_PREFIX.lower()):
                staged_paths = _pending_code_review_paths(session)
                if not staged_paths:
                    return (
                        f'{review_result}\n\n'
                        'Tool error: code review rejected the step, but no staged edits remain to revise.'
                    )
                cleaned_rejection = review_result.strip()
                if cleaned_rejection and cleaned_rejection == prior_rejection:
                    return (
                        f'{review_result}\n\n'
                        'Tool error: code review repeated the same rejection after the previous revision attempt. '
                        'Stop the retry loop and surface this feedback to the planner.'
                    )
                if retry_attempt >= retry_limit:
                    return (
                        f'{review_result}\n\n'
                        f'Tool error: code review retry budget exhausted after {retry_limit} revision round(s). '
                        'Stop the retry loop and surface the reviewer feedback to the planner.'
                    )
                snapshot_before_retry = _pending_code_review_snapshot(session, staged_paths)
                retry_attempt += 1
                update_result = await _run_specialist_graph(
                    'update',
                    _build_code_review_retry_instruction(
                        task_instruction,
                        review_result,
                        staged_paths,
                        retry_attempt=retry_attempt,
                    ),
                )
                if update_result.lower().startswith('aborted by user') or update_result.lower().startswith('tool error:'):
                    return update_result
                snapshot_after_retry = _pending_code_review_snapshot(session, staged_paths)
                if snapshot_after_retry == snapshot_before_retry:
                    return (
                        f'{update_result}\n\n'
                        'Tool error: the update specialist finished after a code review rejection, but the staged '
                        'draft did not change. Stop the retry loop and surface the reviewer feedback to the planner.'
                    )
                prior_rejection = cleaned_rejection
                review_result = await _run_specialist_graph(
                    'code_review',
                    _build_code_review_instruction(session, task_instruction),
                )
                while review_result.lower().startswith(_CODE_REVIEW_DECISION_MISSING_PREFIX.lower()):
                    if decision_retry_attempt >= 1:
                        return review_result
                    decision_retry_attempt += 1
                    review_result = await _run_specialist_graph(
                        'code_review',
                        _build_code_review_force_decision_instruction(session, task_instruction, review_result),
                    )
            return review_result

        @tool
        async def route_project_review_specialist(task_instruction: str) -> str:
            """Hand off final workspace validation to the project review specialist."""
            if not allow_project_review:
                return (
                    'Tool error: `route_project_review_specialist` is reserved for the planner final review pass. '
                    'Finish the current recorded build step and return control to the planner instead.'
                )
            activate_session_lsp_scope(session_id, scope='workspace')
            bootstrap_summary = await maybe_bootstrap_python_workspace_env_for_project_review(session_id)
            if bootstrap_summary.lower().startswith('tool error:'):
                return (
                    'Tool error: final project review could not bootstrap the workspace Python environment.\n\n'
                    f'{bootstrap_summary}'
                )
            review_instruction = task_instruction.strip() or '(no instruction)'
            if bootstrap_summary:
                review_instruction = (
                    f'{review_instruction}\n\n'
                    'Python workspace bootstrap already ran before this final review. Use the summary below as '
                    'context. Use dependency tools if packages or manifests need repair, prefer a smoke test when '
                    'there is an obvious Python entry script, and run `run_workspace_pytest_tests` only when the '
                    'workspace or task provides a real pytest signal.\n\n'
                    f'{bootstrap_summary}'
                )
            return await _run_specialist_graph('project_review', review_instruction)

        router_tools: list[Any] = [
            route_create_specialist,
            route_update_specialist,
            route_delete_specialist,
            route_dependency_specialist,
            route_code_review_specialist,
        ]
        if allow_project_review:
            router_tools.append(route_project_review_specialist)

        system_prompt = build_router_system_prompt(session, allow_project_review=allow_project_review)
        graph = create_agent(
            llm,
            router_tools,
            system_prompt=system_prompt,
            name='nemo_planning_router',
            middleware=[
                ConnectionParallelToolCallsMiddleware(),
                EmptyResponseNudgeMiddleware(),
                AcceptCommandReviewAfterToolMiddleware(),
                DiffReviewAfterToolMiddleware(),
                DeleteReviewAfterToolMiddleware(),
            ],
            checkpointer=checkpointer,
        )
        thread_id = f'{session_id}:planning:{uuid.uuid4().hex[:10]}'
        config: RunnableConfig = {
            'configurable': {'thread_id': thread_id},
            'recursion_limit': MAX_AGENT_STEPS,
        }
        inputs: dict[str, Any] = {'messages': [HumanMessage(content=f'Task:\n{task_summary.strip()}')]}
        try:
            async for ev in graph.astream_events(inputs, config, version='v2'):
                await _enqueue_nested_event(nested_q, 'planning', ev)
                et = ev.get('event')
                data = ev.get('data') if isinstance(ev.get('data'), dict) else {}
                if et == 'on_chat_model_end':
                    raw = data.get('output')
                    msg = raw if isinstance(raw, AIMessage) else None
                    if msg is not None and not (msg.tool_calls or []):
                        last_final_text = final_assistant_text(msg)
        except Exception:
            logger.exception('Planning nested graph failed')
            raise
        finally:
            await nested_q.put(NESTED_WORKER_STREAM_END)

        if not last_final_text.strip():
            last_final_text = (
                'The nested workspace agent finished without a final text response. '
                'Try rephrasing the task.'
            )
        return last_final_text
