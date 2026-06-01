"""Plan-and-execute HITL: user approves the proposed step list before execution."""

from __future__ import annotations

import uuid
from typing import Any

from nemo_backend.domain import SessionState

__all__ = [
    'execute_pending_plan_confirm_decision',
    'plan_confirm_sse_payload',
    'stage_plan_confirm_request',
]


def stage_plan_confirm_request(session: SessionState, *, steps: list[str]) -> dict[str, Any]:
    """Store pending plan approval and return the request dict."""

    request_id = f'plan-{uuid.uuid4().hex[:12]}'
    pending: dict[str, Any] = {
        'request_id': request_id,
        'steps': [str(s).strip() for s in steps if str(s).strip()],
        'title': 'Review plan',
        'message': 'Approve this step list before the agent executes it.',
        'confirm_label': 'Run plan',
        'cancel_label': 'Cancel',
    }
    session.pending_plan_confirm_request = pending
    session.plan_execute_aborted = False
    return pending


def plan_confirm_sse_payload(pending: dict[str, Any]) -> dict[str, Any]:
    """Shape for SSE ``planConfirm`` / frontend ``PlanConfirmPayload``."""

    return {
        'version': 1,
        'requestId': str(pending.get('request_id') or ''),
        'title': str(pending.get('title') or 'Review plan'),
        'message': str(pending.get('message') or ''),
        'confirmLabel': str(pending.get('confirm_label') or 'Run plan'),
        'cancelLabel': str(pending.get('cancel_label') or 'Cancel'),
        'steps': [str(s) for s in (pending.get('steps') or []) if str(s).strip()],
    }


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
        return 'User cancelled the proposed plan.'
    session.plan_execute_aborted = False
    return ''
