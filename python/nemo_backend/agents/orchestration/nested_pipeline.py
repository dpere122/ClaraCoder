"""Single LangGraph router graph: handoff tools run specialist ``create_agent`` subgraphs (streaming to nested queue)."""

from __future__ import annotations

import logging
import re
import uuid
from contextlib import contextmanager
from typing import Any

from langchain.agents import create_agent
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool

from nemo_backend.agents.specialists.prompts import (
    build_code_review_specialist_system_prompt,
    build_dependency_specialist_system_prompt,
    build_delete_specialist_system_prompt,
    build_node_dependency_specialist_system_prompt,
    build_project_review_specialist_system_prompt,
    build_router_system_prompt,
    build_staging_author_system_prompt,
    build_workspace_recon_system_prompt,
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
from nemo_backend.staging_edit_tools import (
    STAGE_CREATE_FILE_NAME,
    STAGE_LINE_RANGE_EDIT_NAME,
    STAGE_SNIPPET_EDIT_NAME,
    STAGE_WORKSPACE_FILE_OVERWRITE_NAME,
)
from nemo_backend.agents.orchestration.router_probe_tools import workspace_path_status
from nemo_backend.project_review_capture import nested_project_review_output_capture
from nemo_backend.agents.specialists.tools import (
    dependency_specialist_tools,
    delete_specialist_tools,
    node_dependency_specialist_tools,
    staging_author_tools,
    workspace_recon_tools,
)
from nemo_backend.config import MAX_AGENT_STEPS, NEMO_OUTER_AGENT_BRIEF_MAX_CHARS
from nemo_backend.accept_command_review_middleware import AcceptCommandReviewAfterToolMiddleware
from nemo_backend.delete_review_middleware import DeleteReviewAfterToolMiddleware
from nemo_backend.diff_review_middleware import DiffReviewAfterToolMiddleware
from nemo_backend.empty_response_middleware import EmptyResponseNudgeMiddleware
from nemo_backend.domain import SessionState
from nemo_backend.llm import build_llm
from nemo_backend.lsp.manager import activate_session_lsp_scope
from nemo_backend.messages import final_assistant_text, stringify_content
from nemo_backend.parallel_tool_middleware import ConnectionParallelToolCallsMiddleware
from nemo_backend.state import get_active_connection, get_session, runtime_config
from nemo_backend.tool_harness_feedback_middleware import prepend_harness_feedback_middleware

logger = logging.getLogger('nemo.agent.langgraph.planning')

NESTED_WORKER_STREAM_END = object()

_CODE_REVIEW_DECISION_TOOL_NAMES = frozenset(
    {TRANSFER_STAGED_FILE_TO_WORKSPACE_NAME, REJECT_STAGED_WORKSPACE_EDIT_NAME}
)
_PROJECT_REVIEW_DECISION_TOOL_NAMES = frozenset({APPROVE_PROJECT_REVIEW_NAME, REJECT_PROJECT_REVIEW_NAME})
_CODE_REVIEW_REJECTION_PREFIX = 'Tool error: code review rejected the current step.'
_CODE_REVIEW_DECISION_MISSING_PREFIX = 'Tool error: code review specialist finished without calling '
_CODE_REVIEW_TRANSFER_INCOMPLETE_PREFIX = (
    'Tool error: code review finished without deciding every staged path.'
)


_NESTED_STAGE_MOCK_TRANSFER_TOOL_NAMES: frozenset[str] = frozenset(
    {
        STAGE_CREATE_FILE_NAME,
        STAGE_WORKSPACE_FILE_OVERWRITE_NAME,
        STAGE_LINE_RANGE_EDIT_NAME,
        STAGE_SNIPPET_EDIT_NAME,
    }
)


def _code_review_needs_decision_followup(result: str) -> bool:
    lower = (result or '').lower()
    return lower.startswith(_CODE_REVIEW_DECISION_MISSING_PREFIX.lower()) or lower.startswith(
        _CODE_REVIEW_TRANSFER_INCOMPLETE_PREFIX.lower()
    )


def _code_review_pending_after_transfer_requires_followup(session: SessionState) -> bool:
    """True when auto-apply (or post-transfer) left other paths still needing transfer/reject.

    When a staged transfer is paused for HITL, the reviewer intentionally stops after one tool call—do not
    treat remaining pending paths as an incomplete multi-file decision in that case.
    """
    remaining = _pending_code_review_paths(session)
    if not remaining:
        return False
    if session.pending_staged_transfer_hitl is not None:
        return False
    return True


def _maybe_mark_workspace_applied_from_transfer_tool_message(
    session: SessionState, tool_name: str, tool_result: str
) -> None:
    """Keep ``pending_edit_stagings`` consistent when tests mock ``on_tool_end`` without running real transfer.

    Real ``transfer_staged_file_to_workspace`` (or stage + ``land_in_workspace``) already set ``workspace_applied`` on
    success. Skip HITL outputs so we do not mark applied while the human still owes confirmation.
    """
    if tool_name != TRANSFER_STAGED_FILE_TO_WORKSPACE_NAME and tool_name not in _NESTED_STAGE_MOCK_TRANSFER_TOOL_NAMES:
        return
    text = (tool_result or '').strip()
    if text.lower().startswith('tool error:'):
        return
    lower = text.lower()
    if 'human confirmation' in lower or 'diff card' in lower:
        return
    if 'transferred staged' not in lower and 'approved staged' not in lower:
        return
    for match in re.finditer(r'`([^`]+)`', text):
        rel = match.group(1).strip().replace('\\', '/')
        entry = session.pending_edit_stagings.get(rel)
        if entry is None:
            continue
        try:
            entry.workspace_applied = True
        except (AttributeError, TypeError):
            pass


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
    decision_hint = (
        '\n\nReviewer decision: `transfer_staged_file_to_workspace` = PASS (draft OK, apply to workspace). '
        '`reject_staged_workspace_edit` = FAIL (draft needs writer fixes—feedback must say what is wrong). '
        'Do not reject when the draft already satisfies the step. '
        'Do **not** instruct the user to apply or approve the diff—you must call the tools yourself.'
    )
    transfer_order = ''
    staged_paths = _pending_code_review_paths(session)
    if len(staged_paths) > 1:
        transfer_order = (
            '\n\n**Transfer order:** When multiple files are pending, call `transfer_staged_file_to_workspace` in '
            '**lexicographic ascending order** of workspace-relative POSIX paths (sorted strings), or reject paths '
            'that fail review—do not skip any pending path.'
        )
    if not staged_paths:
        return base + decision_hint + transfer_order
    test_paths = [path for path in staged_paths if _is_probable_test_path(path)]
    lines = [base, '', 'Staged paths:']
    lines.extend(f'- `{path}`' for path in staged_paths)
    lines.extend(['', 'Related staged test files:'])
    if test_paths:
        lines.extend(f'- `{path}`' for path in test_paths)
    else:
        lines.append('- None identified in the current staged set.')
    lines.extend(['', decision_hint.strip()])
    if transfer_order:
        lines.append(transfer_order.strip())
    return '\n'.join(lines)


def _build_auto_code_review_followup_instruction(
    mutation_kind: str,
    task_instruction: str,
    mutation_result: str,
) -> str:
    base = task_instruction.strip() or 'Review the staged changes and decide whether to transfer or reject.'
    kind_label = {'write': 'file-write', 'create': 'create', 'update': 'update'}.get(
        mutation_kind,
        mutation_kind,
    )
    summary = mutation_result.strip() or '(no specialist summary provided)'
    return (
        f'{base}\n\n'
        f'The {kind_label} specialist staged code for review and returned this summary:\n'
        f'{summary}\n\n'
        'Complete the staged review now. If the review rejects the draft, keep the fix inside the same current '
        'step and continue through the nested revision loop until the staged file transfers or a real tool failure occurs.'
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
    prior_lower = prior.lower()
    incomplete = prior_lower.startswith(_CODE_REVIEW_TRANSFER_INCOMPLETE_PREFIX.lower())
    if incomplete:
        force_body = (
            'You transferred at least one path but other staged paths still need a decision. Use the staged draft as '
            'the source of truth, then call `transfer_staged_file_to_workspace` or `reject_staged_workspace_edit` for '
            '**each** remaining path—finishing one file does not complete the step when others are still pending.'
        )
    else:
        force_body = (
            'Your previous review turn ended without calling the required decision tool. Use the staged draft as the '
            'source of truth, then finish this turn with exactly one of '
            '`transfer_staged_file_to_workspace` or `reject_staged_workspace_edit`.'
        )
    if prior:
        return f'{base}\n\n{force_body}\n\nPrevious outcome:\n{prior}'
    return f'{base}\n\n{force_body}'


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


_OUTER_BRIEF_KIND_LABELS: dict[str, str] = {
    'plan_recorded': 'Planner checklist',
    'plan_extended_after_review': 'Planner checklist extension',
    'plan_auto_remediation': 'Planner remediation step',
    'code_review': 'Code review',
    'project_review': 'Project review',
}


def _truncate_outer_brief_text(text: str) -> str:
    t = (text or '').strip()
    if len(t) <= NEMO_OUTER_AGENT_BRIEF_MAX_CHARS:
        return t
    return t[: max(0, NEMO_OUTER_AGENT_BRIEF_MAX_CHARS - 24)].rstrip() + '\n[truncated]'


async def enqueue_plan_and_modify_outer_brief(
    session_id: str,
    nested_q: Any,
    *,
    kind: str,
    summary: str,
) -> None:
    """Append a concise handoff for outer Clara (``plan_and_modify`` tool text + live status line)."""
    body = _truncate_outer_brief_text(summary)
    if not body:
        return
    session = get_session(session_id)
    label = _OUTER_BRIEF_KIND_LABELS.get(kind, str(kind).replace('_', ' ').title())
    session.plan_and_modify_outer_briefs.append(f'{label}:\n{body}')
    await _enqueue_nested_event(
        nested_q,
        'clara',
        {'event': 'outer_agent_brief', 'data': {'kind': kind, 'summary': body, 'label': label}},
    )


def _write_specialist_middleware() -> list[Any]:
    return prepend_harness_feedback_middleware(
        [
            ConnectionParallelToolCallsMiddleware(),
            EmptyResponseNudgeMiddleware(),
            AcceptCommandReviewAfterToolMiddleware(),
            DiffReviewAfterToolMiddleware(),
            DeleteReviewAfterToolMiddleware(),
        ],
    )


async def run_write_recon_then_author_stream(
    session: SessionState,
    session_id: str,
    task_instruction: str,
    nested_q: Any,
    checkpointer: Any,
    *,
    edit_strict: bool,
) -> str:
    """Two-phase file-write: workspace recon (read-only) then staging author (mutators only).

    The author subgraph intentionally has **no** workspace read/search/LSP tools—only staging
    mutators plus ``read_staged_edit`` and ``report_insufficient_workspace_recon``. Recon runs
    with ``activate_session_lsp_scope(..., scope='workspace')`` and the author with ``scope='staging'``
    so LSP queries match the checkpoint vs staging data planes. We do **not** attach workspace reads
    to the author (avoids mixing live checkpoint truth with staged-draft edits); at most **one**
    supplemental recon pass runs when the author records a supplement request, then the author
    is invoked again with the merged ``Workspace recon`` text.
    """
    session.write_recon_supplement_request = ''
    spec_llm = build_llm()
    base_task = task_instruction.strip() or '(no instruction)'
    recon_fallback = (
        '(no workspace recon summary text; use the routing handoff only and stage conservatively.)'
    )

    async def _run_workspace_recon_human(human_content: str) -> str:
        activate_session_lsp_scope(session_id, scope='workspace')
        recon_tools, _ = workspace_recon_tools()
        recon_prompt = build_workspace_recon_system_prompt(session)
        recon_graph = create_agent(
            spec_llm,
            recon_tools,
            system_prompt=recon_prompt,
            name='nemo_specialist_write_recon',
            middleware=_write_specialist_middleware(),
            checkpointer=checkpointer,
        )
        recon_thread = f'{session_id}:spec:write_recon:{uuid.uuid4().hex[:10]}'
        recon_config: RunnableConfig = {
            'configurable': {'thread_id': recon_thread},
            'recursion_limit': MAX_AGENT_STEPS,
        }
        recon_inputs: dict[str, Any] = {'messages': [HumanMessage(content=human_content)]}
        recon_final = ''
        recon_tag = f'spec-write-recon-{uuid.uuid4().hex[:8]}'
        async for ev in recon_graph.astream_events(recon_inputs, recon_config, version='v2'):
            await _enqueue_nested_event(nested_q, recon_tag, ev)
            et = ev.get('event')
            data = ev.get('data') if isinstance(ev.get('data'), dict) else {}
            if et == 'on_chat_model_end':
                raw = data.get('output')
                msg = raw if isinstance(raw, AIMessage) else None
                if msg is not None and not (msg.tool_calls or []):
                    recon_final = final_assistant_text(msg)
        return recon_final.strip() or recon_fallback

    async def _run_staging_author(recon_body: str) -> str:
        activate_session_lsp_scope(session_id, scope='staging')
        author_tools, _ = staging_author_tools(edit_strict)
        author_prompt = build_staging_author_system_prompt(session)
        author_graph = create_agent(
            spec_llm,
            author_tools,
            system_prompt=author_prompt,
            name='nemo_specialist_write_author',
            middleware=_write_specialist_middleware(),
            checkpointer=checkpointer,
        )
        author_thread = f'{session_id}:spec:write_author:{uuid.uuid4().hex[:10]}'
        author_config: RunnableConfig = {
            'configurable': {'thread_id': author_thread},
            'recursion_limit': MAX_AGENT_STEPS,
        }
        combined_human = (
            '--- Workspace recon (on-disk / LSP; authoritative for paths and excerpts) ---\n'
            f'{recon_body}\n\n'
            '--- Original write task ---\n'
            f'{base_task}'
        )
        author_inputs: dict[str, Any] = {'messages': [HumanMessage(content=combined_human)]}
        author_final = ''
        author_tag = f'spec-write-author-{uuid.uuid4().hex[:8]}'
        async for ev in author_graph.astream_events(author_inputs, author_config, version='v2'):
            await _enqueue_nested_event(nested_q, author_tag, ev)
            et = ev.get('event')
            data = ev.get('data') if isinstance(ev.get('data'), dict) else {}
            if et == 'on_chat_model_end':
                raw = data.get('output')
                msg = raw if isinstance(raw, AIMessage) else None
                if msg is not None and not (msg.tool_calls or []):
                    author_final = final_assistant_text(msg)
        return author_final.strip() or recon_body

    recon_body = await _run_workspace_recon_human(base_task)
    author_out = await _run_staging_author(recon_body)
    supplement = session.write_recon_supplement_request.strip()
    if supplement:
        session.write_recon_supplement_request = ''
        supplement_human = (
            'The staging author could not proceed without more workspace facts. Gather **only** what is listed below; '
            'then end with one assistant message starting `Workspace recon:` (focus on new facts; prefix bullets with '
            '`Supplemental:` where helpful).\n\n'
            f'--- Missing facts (from author) ---\n{supplement}\n\n'
            f'--- Original write task (context) ---\n{base_task}'
        )
        extra = await _run_workspace_recon_human(supplement_human)
        recon_body = f'{recon_body}\n\n--- Supplemental workspace recon ---\n{extra}'
        author_out = await _run_staging_author(recon_body)
    session.write_recon_supplement_request = ''
    return author_out


async def run_specialist_agent_stream(
    session: SessionState,
    session_id: str,
    kind: str,
    task_instruction: str,
    nested_q: Any,
    checkpointer: Any,
) -> str:
    """Run a single specialist ``create_agent`` subgraph; stream LangGraph v2 events to *nested_q*."""
    edit_strict = runtime_config.tools.edit_tools_strict
    if kind == 'code_review':
        activate_session_lsp_scope(session_id, scope='staging')
    if kind == 'write':
        return await run_write_recon_then_author_stream(
            session,
            session_id,
            task_instruction,
            nested_q,
            checkpointer,
            edit_strict=edit_strict,
        )
    spec_llm = build_llm()
    if kind == 'delete':
        tools, _ = delete_specialist_tools()
        system_prompt = build_delete_specialist_system_prompt(session)
    elif kind == 'dependency':
        tools, _ = dependency_specialist_tools()
        system_prompt = build_dependency_specialist_system_prompt(session)
    elif kind == 'node_dependency':
        tools, _ = node_dependency_specialist_tools()
        system_prompt = build_node_dependency_specialist_system_prompt(session)
    elif kind == 'code_review':
        tools, _ = code_review_specialist_tools()
        system_prompt = build_code_review_specialist_system_prompt(session)
    elif kind == 'project_review':
        tools, _ = project_review_specialist_tools()
        system_prompt = build_project_review_specialist_system_prompt(session)
    else:
        return f'Unknown specialist kind: {kind}'

    if kind == 'project_review':
        session.last_project_review_subprocess_report = ''

    sub = create_agent(
        spec_llm,
        tools,
        system_prompt=system_prompt,
        name=f'nemo_specialist_{kind}',
        middleware=prepend_harness_feedback_middleware(
            [
                ConnectionParallelToolCallsMiddleware(),
                EmptyResponseNudgeMiddleware(),
                AcceptCommandReviewAfterToolMiddleware(),
                DiffReviewAfterToolMiddleware(),
                DeleteReviewAfterToolMiddleware(),
            ],
        ),
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
    capture_token = None
    if kind == 'project_review':
        capture_token = nested_project_review_output_capture.set(True)
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
                        _maybe_mark_workspace_applied_from_transfer_tool_message(
                            session, tool_name, tool_result
                        )
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
    finally:
        if capture_token is not None:
            nested_project_review_output_capture.reset(capture_token)
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
        rejection_body = review_decision_result or spec_final.strip()
        await enqueue_plan_and_modify_outer_brief(
            session_id,
            nested_q,
            kind='code_review',
            summary=f'Rejected staged changes (revision required).\n{rejection_body}',
        )
        return (
            'Tool error: code review rejected the current step. Retry the same recorded step with only the '
            'minimum in-scope fixes needed for approval; do not broaden the task or create a new plan.\n\n'
            f'{rejection_body}'
        )
    if (
        kind == 'code_review'
        and review_decision_made
        and review_decision_tool == TRANSFER_STAGED_FILE_TO_WORKSPACE_NAME
        and _code_review_pending_after_transfer_requires_followup(session)
    ):
        remaining = _pending_code_review_paths(session)
        logger.warning(
            'Code review specialist transferred at least one path but left other pending paths; final_text=%r '
            'remaining=%s',
            spec_final[:240],
            remaining,
        )
        return (
            _CODE_REVIEW_TRANSFER_INCOMPLETE_PREFIX
            + ' Call `transfer_staged_file_to_workspace` or `reject_staged_workspace_edit` for each remaining path.'
            f' Remaining: {", ".join(f"`{p}`" for p in remaining)}.'
            f' Review summary: {spec_final.strip() or "(no final text provided)"}'
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
        fail_body = project_review_decision_result or spec_final.strip()
        await enqueue_plan_and_modify_outer_brief(
            session_id,
            nested_q,
            kind='project_review',
            summary=f'Final review failed.\n{fail_body}',
        )
        return (
            'Tool error: final project review failed. Use the reviewer feedback to make the minimum '
            'workspace fixes needed for another final review pass.\n\n'
            f'{fail_body}'
        )
    if kind == 'code_review' and review_decision_made and review_decision_tool == TRANSFER_STAGED_FILE_TO_WORKSPACE_NAME:
        await enqueue_plan_and_modify_outer_brief(
            session_id,
            nested_q,
            kind='code_review',
            summary=review_decision_result
            or spec_final.strip()
            or 'Staged changes approved and transferred to the workspace.',
        )
    elif (
        kind == 'project_review'
        and project_review_decision_made
        and project_review_decision_tool == APPROVE_PROJECT_REVIEW_NAME
    ):
        await enqueue_plan_and_modify_outer_brief(
            session_id,
            nested_q,
            kind='project_review',
            summary=project_review_decision_result
            or spec_final.strip()
            or 'Final project review approved.',
        )
    return spec_final.strip() or f'Specialist `{kind}` finished without a final text response.'


async def run_final_project_review_stream(
    session: SessionState,
    session_id: str,
    review_instruction: str,
    nested_q: Any,
    checkpointer: Any,
) -> str:
    """Run only the project-review specialist (no nested router); enqueue events then ``NESTED_WORKER_STREAM_END``."""
    try:
        _ = build_llm()
    except Exception:
        await nested_q.put(NESTED_WORKER_STREAM_END)
        raise

    with _suppress_parent_graph_model_token_sse(session):
        try:
            activate_session_lsp_scope(session_id, scope='workspace')
            bootstrap_summary = await maybe_bootstrap_python_workspace_env_for_project_review(session_id)
            if bootstrap_summary.lower().startswith('tool error:'):
                return (
                    'Tool error: final project review could not bootstrap the workspace Python environment.\n\n'
                    f'{bootstrap_summary}'
                )
            review_text = review_instruction.strip() or '(no instruction)'
            if bootstrap_summary:
                review_text = (
                    f'{review_text}\n\n'
                    'Python workspace bootstrap already ran before this final review. Use the summary below as '
                    'context. Use dependency tools if packages or manifests need repair, prefer a smoke test when '
                    'there is an obvious Python entry script, and run `run_workspace_pytest_tests` only when the '
                    'workspace or task provides a real pytest signal.\n\n'
                    f'{bootstrap_summary}'
                )
            return await run_specialist_agent_stream(
                session,
                session_id,
                'project_review',
                review_text,
                nested_q,
                checkpointer,
            )
        finally:
            await nested_q.put(NESTED_WORKER_STREAM_END)


async def run_planning_nested_stream(
    session: SessionState,
    session_id: str,
    task_summary: str,
    nested_q: Any,
    checkpointer: Any,
) -> str:
    """Run nested planning router; enqueue LangGraph v2 events, then ``NESTED_WORKER_STREAM_END``."""
    last_final_text = ''
    try:
        llm = build_llm()
    except Exception:
        await nested_q.put(NESTED_WORKER_STREAM_END)
        raise

    with _suppress_parent_graph_model_token_sse(session):
        async def _run_mutation_specialist_with_auto_review(kind: str, task_instruction: str) -> str:
            mutation_result = await run_specialist_agent_stream(
                session, session_id, kind, task_instruction, nested_q, checkpointer
            )
            lowered = mutation_result.lower()
            if lowered.startswith('aborted by user') or lowered.startswith('tool error:'):
                return mutation_result
            pending_after = set(session.pending_edit_stagings.keys())
            if not pending_after:
                return mutation_result
            # Always chain code review when anything remains staged after a write. Do not key off
            # "new" paths only: updating an existing staged draft keeps the same relative keys, so
            # revision rounds must still run review and transfer.
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
        async def route_write_specialist(task_instruction: str) -> str:
            """Hand off new files, full-file writes, and updates to the unified file-write specialist."""
            return await _run_mutation_specialist_with_auto_review('write', task_instruction)

        @tool
        async def route_delete_specialist(task_instruction: str) -> str:
            """Hand off file or directory deletion to the delete specialist."""
            return await run_specialist_agent_stream(
                session, session_id, 'delete', task_instruction, nested_q, checkpointer
            )

        @tool
        async def route_dependency_specialist(task_instruction: str) -> str:
            """Hand off Python dependency and manifest actions to the dependency specialist."""
            return await run_specialist_agent_stream(
                session, session_id, 'dependency', task_instruction, nested_q, checkpointer
            )

        @tool
        async def route_node_dependency_specialist(task_instruction: str) -> str:
            """Hand off Node/npm/pnpm/Yarn installs, removals, and package.json scripts to the Node dependency specialist."""
            return await run_specialist_agent_stream(
                session, session_id, 'node_dependency', task_instruction, nested_q, checkpointer
            )

        @tool
        async def route_code_review_specialist(task_instruction: str) -> str:
            """Hand off staged code edits to the code review specialist (read/search staging, approve or reject)."""
            retry_attempt = 0
            retry_limit = max(1, int(get_active_connection().plan_retry_attempts_count))
            prior_rejection = ''
            initial_pending = len(_pending_code_review_paths(session))
            if initial_pending == 0:
                return 'Tool error: no staged edits are currently awaiting code review.'
            max_decision_followups = max(8, initial_pending * 2)

            async def _run_code_review_turn(instruction: str) -> str:
                return await run_specialist_agent_stream(
                    session,
                    session_id,
                    'code_review',
                    instruction,
                    nested_q,
                    checkpointer,
                )

            async def _drain_code_review_decision_followups(review_result: str) -> str:
                rounds = 0
                while _code_review_needs_decision_followup(review_result) and rounds < max_decision_followups:
                    rounds += 1
                    review_result = await _run_code_review_turn(
                        _build_code_review_force_decision_instruction(session, task_instruction, review_result)
                    )
                return review_result

            review_result = await _run_code_review_turn(_build_code_review_instruction(session, task_instruction))
            review_result = await _drain_code_review_decision_followups(review_result)
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
                update_result = await run_specialist_agent_stream(
                    session,
                    session_id,
                    'write',
                    _build_code_review_retry_instruction(
                        task_instruction,
                        review_result,
                        staged_paths,
                        retry_attempt=retry_attempt,
                    ),
                    nested_q,
                    checkpointer,
                )
                if update_result.lower().startswith('aborted by user') or update_result.lower().startswith('tool error:'):
                    return update_result
                snapshot_after_retry = _pending_code_review_snapshot(session, staged_paths)
                if snapshot_after_retry == snapshot_before_retry:
                    return (
                        f'{update_result}\n\n'
                        'Tool error: the write specialist finished after a code review rejection, but the staged '
                        'draft did not change. Stop the retry loop and surface the reviewer feedback to the planner.'
                    )
                prior_rejection = cleaned_rejection
                review_result = await _run_code_review_turn(_build_code_review_instruction(session, task_instruction))
                review_result = await _drain_code_review_decision_followups(review_result)
            return review_result

        router_tools: list[Any] = [
            workspace_path_status,
            route_write_specialist,
            route_delete_specialist,
            route_dependency_specialist,
            route_node_dependency_specialist,
            route_code_review_specialist,
        ]

        system_prompt = build_router_system_prompt(session)
        graph = create_agent(
            llm,
            router_tools,
            system_prompt=system_prompt,
            name='nemo_planning_router',
            middleware=prepend_harness_feedback_middleware(
                [
                    ConnectionParallelToolCallsMiddleware(),
                    EmptyResponseNudgeMiddleware(),
                    AcceptCommandReviewAfterToolMiddleware(),
                    DiffReviewAfterToolMiddleware(),
                    DeleteReviewAfterToolMiddleware(),
                ],
            ),
            checkpointer=checkpointer,
        )
        # Random suffix per nested run; outer Clara thread stays stable per conversation.
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
