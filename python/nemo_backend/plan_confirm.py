"""Plan-and-execute HITL: user approves the proposed step list before execution."""

from __future__ import annotations

import uuid
from typing import Any

from nemo_backend.build_plan_store import cancel_build_plan
from nemo_backend.domain import SessionState

__all__ = [
    'execute_pending_plan_confirm_decision',
    'plan_confirm_sse_payload',
    'stage_plan_confirm_request',
]


def stage_plan_confirm_request(
    session: SessionState,
    *,
    steps: list[str],
    build_plan_id: str = '',
    build_plan_path: str = '',
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
