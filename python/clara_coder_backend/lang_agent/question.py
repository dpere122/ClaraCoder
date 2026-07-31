"""Plan-mode HITL: ask the user a batch of clarifying questions before plan confirm.

The planner surfaces ``open_questions`` (see :mod:`clara_coder_backend.plan.build_plan_store`). This module
stages them as a HITL request, shapes the SSE payload, and resolves the user's structured answers
(or cancel). The orchestrator pauses on ``agent_pause_event`` (see
:func:`clara_coder_backend.lang_agent.pause.await_question_answers`) between staging and resolution.
"""

from __future__ import annotations

import uuid
from typing import Any

from clara_coder_backend.session.domain import SessionState

__all__ = [
    'agent_question_sse_payload',
    'execute_pending_question_decision',
    'stage_question_request',
]


def _option_id(question_id: str, index: int) -> str:
    return f'{question_id}-opt-{index + 1}'


def stage_question_request(
    session: SessionState,
    *,
    questions: list[dict[str, Any]],
    build_plan_id: str = '',
    build_plan_path: str = '',
    title: str = 'Clarify the plan',
    message: str = 'Answer a few questions so the plan reflects what you want.',
    submit_label: str = 'Submit answers',
    cancel_label: str = 'Cancel',
) -> dict[str, Any]:
    """Store pending question request and return the request dict.

    ``questions`` is a list of dicts with ``id``, ``prompt``, and ``options`` (list[str]).
    The UI always appends an "Other" free-text choice per question.
    """

    request_id = f'q-{uuid.uuid4().hex[:12]}'
    shaped: list[dict[str, Any]] = []
    for i, q in enumerate(questions or []):
        qid = str(q.get('id') or f'q-{i + 1}').strip() or f'q-{i + 1}'
        prompt = str(q.get('prompt') or '').strip()
        if not prompt:
            continue
        raw_options = q.get('options') or []
        options = [
            {'id': _option_id(qid, j), 'label': str(opt).strip()}
            for j, opt in enumerate(raw_options)
            if str(opt).strip()
        ]
        shaped.append(
            {
                'id': qid,
                'prompt': prompt,
                'options': options,
                'allowOther': True,
            }
        )

    pending: dict[str, Any] = {
        'request_id': request_id,
        'questions': shaped,
        'title': title,
        'message': message,
        'submit_label': submit_label,
        'cancel_label': cancel_label,
        'build_plan_id': (build_plan_id or session.active_build_plan_id or '').strip(),
        'build_plan_path': (build_plan_path or session.active_build_plan_path or '').strip(),
    }
    session.pending_question_request = pending
    session.question_aborted = False
    session.question_answers = None
    return pending


def agent_question_sse_payload(pending: dict[str, Any]) -> dict[str, Any]:
    """Shape for SSE ``agent_question`` / frontend ``AgentQuestionPayload``."""

    payload: dict[str, Any] = {
        'version': 1,
        'requestId': str(pending.get('request_id') or ''),
        'title': str(pending.get('title') or 'Clarify the plan'),
        'message': str(pending.get('message') or ''),
        'submitLabel': str(pending.get('submit_label') or 'Submit answers'),
        'cancelLabel': str(pending.get('cancel_label') or 'Cancel'),
        'questions': list(pending.get('questions') or []),
    }
    plan_id = str(pending.get('build_plan_id') or '').strip()
    plan_path = str(pending.get('build_plan_path') or '').strip()
    if plan_id:
        payload['planId'] = plan_id
    if plan_path:
        payload['buildPlanPath'] = plan_path
    return payload


def execute_pending_question_decision(
    session: SessionState,
    *,
    action: str,
    request_id: str | None,
    answers: list[dict[str, Any]] | None = None,
) -> str:
    """Resolve a question request; orchestrator reads ``question_answers`` / ``question_aborted``."""

    pending = session.pending_question_request
    if not pending:
        return ''
    if request_id and pending.get('request_id') != request_id:
        session.pending_question_request = None
        return 'Question request ignored (stale or mismatched request).'
    session.pending_question_request = None
    if action != 'submit':
        session.question_aborted = True
        session.question_answers = None
        return 'User cancelled the clarifying questions.'
    session.question_aborted = False
    normalized: list[dict[str, Any]] = []
    for ans in answers or []:
        qid = str(ans.get('question_id') or ans.get('questionId') or '').strip()
        if not qid:
            continue
        option_id = str(ans.get('option_id') or ans.get('optionId') or '').strip() or None
        other_text = str(ans.get('other_text') or ans.get('otherText') or '').strip() or None
        if not option_id and not other_text:
            continue
        normalized.append(
            {
                'question_id': qid,
                'option_id': option_id,
                'other_text': other_text,
            }
        )
    session.question_answers = normalized
    return ''
