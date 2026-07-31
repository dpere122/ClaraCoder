"""Plan-and-execute HITL: user approves the proposed step list before execution."""

from __future__ import annotations

import uuid
from typing import Any

from clara_coder_backend.build_plan_store import cancel_build_plan, coerce_file_change_entry
from clara_coder_backend.domain import SessionState

__all__ = [
    'execute_pending_plan_confirm_decision',
    'plan_confirm_sse_payload',
    'stage_plan_confirm_request',
]


def _normalize_files_to_change(files_to_change: list[Any] | None) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for raw in files_to_change or []:
        entry = coerce_file_change_entry(raw)
        if entry is None:
            continue
        out.append(
            {
                'path': entry.path,
                'operation': entry.operation,
                'rationale': entry.rationale,
            }
        )
    return out


def stage_plan_confirm_request(
    session: SessionState,
    *,
    steps: list[str],
    build_plan_id: str = '',
    build_plan_path: str = '',
    files_to_change: list[Any] | None = None,
    current_implementation: str = '',
    risks: list[str] | None = None,
    definition_of_done: list[str] | None = None,
    resolved_questions: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    """Store pending plan approval and return the request dict."""

    request_id = f'plan-{uuid.uuid4().hex[:12]}'
    pending: dict[str, Any] = {
        'request_id': request_id,
        'steps': [str(s).strip() for s in steps if str(s).strip()],
        'title': 'Review plan',
        'message': 'Approve this build plan before the agent executes it.',
        'confirm_label': 'Run plan',
        'cancel_label': 'Cancel',
        'build_plan_id': (build_plan_id or session.active_build_plan_id or '').strip(),
        'build_plan_path': (build_plan_path or session.active_build_plan_path or '').strip(),
        'files_to_change': _normalize_files_to_change(files_to_change),
        'current_implementation': (current_implementation or '').strip(),
        'risks': [str(r).strip() for r in (risks or []) if str(r).strip()],
        'definition_of_done': [str(d).strip() for d in (definition_of_done or []) if str(d).strip()],
        'resolved_questions': [
            {'prompt': str(q.get('prompt') or '').strip(), 'answer': str(q.get('answer') or '').strip()}
            for q in (resolved_questions or [])
            if str(q.get('prompt') or '').strip() and str(q.get('answer') or '').strip()
        ],
    }
    session.pending_plan_confirm_request = pending
    session.plan_execute_aborted = False
    return pending


def plan_confirm_sse_payload(pending: dict[str, Any]) -> dict[str, Any]:
    """Shape for SSE ``planConfirm`` / frontend ``PlanConfirmPayload``."""

    payload: dict[str, Any] = {
        'version': 1,
        'requestId': str(pending.get('request_id') or ''),
        'title': str(pending.get('title') or 'Review plan'),
        'message': str(pending.get('message') or ''),
        'confirmLabel': str(pending.get('confirm_label') or 'Run plan'),
        'cancelLabel': str(pending.get('cancel_label') or 'Cancel'),
        'steps': [str(s) for s in (pending.get('steps') or []) if str(s).strip()],
        'filesToChange': [
            {
                'path': str(f.get('path') or ''),
                'operation': str(f.get('operation') or 'modify'),
                'rationale': str(f.get('rationale') or ''),
            }
            for f in _normalize_files_to_change(list(pending.get('files_to_change') or []))
        ],
        'currentImplementation': str(pending.get('current_implementation') or ''),
        'risks': [str(r) for r in (pending.get('risks') or []) if str(r).strip()],
        'definitionOfDone': [str(d) for d in (pending.get('definition_of_done') or []) if str(d).strip()],
        'resolvedQuestions': [
            {'prompt': str(q.get('prompt') or ''), 'answer': str(q.get('answer') or '')}
            for q in (pending.get('resolved_questions') or [])
            if str(q.get('prompt') or '').strip()
        ],
    }
    plan_id = str(pending.get('build_plan_id') or '').strip()
    plan_path = str(pending.get('build_plan_path') or '').strip()
    if plan_id:
        payload['planId'] = plan_id
    if plan_path:
        payload['buildPlanPath'] = plan_path
    return payload


def execute_pending_plan_confirm_decision(
    session: SessionState,
    *,
    confirm: bool,
    request_id: str | None,
) -> str:
    """Resolve plan approval; orchestrator reads ``plan_execute_aborted`` after pause."""

    pending = session.pending_plan_confirm_request
    if not pending:
        return ''
    if request_id and pending.get('request_id') != request_id:
        session.pending_plan_confirm_request = None
        return 'Plan confirmation ignored (stale or mismatched request).'
    session.pending_plan_confirm_request = None
    if not confirm:
        session.plan_execute_aborted = True
        plan_id = str(pending.get('build_plan_id') or session.active_build_plan_id or '').strip()
        if plan_id:
            cancel_build_plan(session, plan_id)
        return 'User cancelled the proposed plan.'
    session.plan_execute_aborted = False
    return ''
