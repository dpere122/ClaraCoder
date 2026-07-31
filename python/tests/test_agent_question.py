from __future__ import annotations

from clara_coder_backend.agent_question import (
    agent_question_sse_payload,
    execute_pending_question_decision,
    stage_question_request,
)
from clara_coder_backend.domain import SessionState


def _questions() -> list[dict]:
    return [
        {'id': 'q-1', 'prompt': 'Use REST or gRPC?', 'options': ['REST', 'gRPC']},
        {'id': 'q-2', 'prompt': 'Add tests now?', 'options': ['Yes', 'No']},
    ]


def test_stage_question_request_shapes_questions_with_allow_other() -> None:
    session = SessionState()
    pending = stage_question_request(session, questions=_questions(), build_plan_id='plan-1')
    assert pending['request_id'].startswith('q-')
    assert len(pending['questions']) == 2
    first = pending['questions'][0]
    assert first['id'] == 'q-1'
    assert first['prompt'] == 'Use REST or gRPC?'
    assert first['allowOther'] is True
    assert [o['label'] for o in first['options']] == ['REST', 'gRPC']
    assert first['options'][0]['id'] == 'q-1-opt-1'
    assert session.pending_question_request is pending


def test_agent_question_sse_payload_camelcases_fields() -> None:
    session = SessionState()
    pending = stage_question_request(session, questions=_questions(), build_plan_id='plan-1', build_plan_path='.nemo/build-plans/plan-1.md')
    payload = agent_question_sse_payload(pending)
    assert payload['version'] == 1
    assert payload['requestId'] == pending['request_id']
    assert payload['submitLabel'] == 'Submit answers'
    assert payload['planId'] == 'plan-1'
    assert payload['buildPlanPath'] == '.nemo/build-plans/plan-1.md'
    assert len(payload['questions']) == 2
    assert payload['questions'][0]['allowOther'] is True


def test_execute_pending_question_decision_stores_answers() -> None:
    session = SessionState()
    pending = stage_question_request(session, questions=_questions())
    answers = [
        {'question_id': 'q-1', 'option_id': 'q-1-opt-1'},
        {'question_id': 'q-2', 'other_text': 'Maybe later'},
    ]
    note = execute_pending_question_decision(
        session,
        action='submit',
        request_id=pending['request_id'],
        answers=answers,
    )
    assert note == ''
    assert session.question_aborted is False
    assert session.question_answers == [
        {'question_id': 'q-1', 'option_id': 'q-1-opt-1', 'other_text': None},
        {'question_id': 'q-2', 'option_id': None, 'other_text': 'Maybe later'},
    ]
    assert session.pending_question_request is None


def test_execute_pending_question_decision_cancel_aborts() -> None:
    session = SessionState()
    pending = stage_question_request(session, questions=_questions())
    note = execute_pending_question_decision(session, action='cancel', request_id=pending['request_id'])
    assert 'cancelled' in note.lower()
    assert session.question_aborted is True
    assert session.question_answers is None


def test_execute_pending_question_decision_ignores_stale_request() -> None:
    session = SessionState()
    stage_question_request(session, questions=_questions())
    note = execute_pending_question_decision(session, action='submit', request_id='wrong-id')
    assert 'ignored' in note.lower()
    assert session.pending_question_request is None
    assert session.question_answers is None
