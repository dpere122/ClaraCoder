"""Build-plan lifecycle routes (cancel active plan + abort stream)."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from clara_coder_backend.build_plan_store import cancel_build_plan
from clara_coder_backend.schemas import BuildPlanCancelRequest
from clara_coder_backend.state import get_session

logger = logging.getLogger('clara.http.build_plan')

router = APIRouter(tags=['build-plan'])


@router.post('/build-plan/cancel')
async def build_plan_cancel(body: BuildPlanCancelRequest) -> dict[str, bool]:
    """Delete an active build plan Markdown file and abort any in-flight agent stream."""

    session = get_session(body.session_id)
    plan_id = (body.plan_id or '').strip()
    if not plan_id:
        raise HTTPException(status_code=400, detail='plan_id is required')
    removed = cancel_build_plan(session, plan_id)
    if not removed:
        logger.info('build-plan cancel: plan %s not found for session %s', plan_id, body.session_id)
    session.abort_event.set()
    return {'ok': True}
