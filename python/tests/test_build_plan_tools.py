from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from nemo_backend.build_plan_store import ActionStep, BuildPlanModel, create_build_plan, parse_action_steps
from nemo_backend.domain import SessionState
from nemo_backend.tools.build_plan_tools import mark_build_plan_steps_complete, read_build_plan


def _sample_doc() -> BuildPlanModel:
    return BuildPlanModel(
        title='Tool test',
        task='Verify tools',
        current_implementation='Baseline',
        files_to_change=['src/x.ts — edit'],
        action_steps=[
            ActionStep(id='step-1', goal='First milestone'),
            ActionStep(id='step-2', goal='Second milestone'),
        ],
    )


def test_read_build_plan_returns_md(tmp_path: Path) -> None:
    from nemo_backend.state import current_session_id, sessions

    session = SessionState(workspace_path=str(tmp_path))
    create_build_plan(str(tmp_path), 'sess-read', _sample_doc(), session=session)
    sessions['sess-read'] = session
    token = current_session_id.set('sess-read')
    try:
        body = read_build_plan.invoke({})
    finally:
        current_session_id.reset(token)
    assert 'First milestone' in body


@pytest.mark.asyncio(loop_scope='function')
async def test_mark_build_plan_steps_complete_emits_planner_progress(tmp_path: Path) -> None:
    from nemo_backend.state import current_session_id, sessions

    session = SessionState(workspace_path=str(tmp_path))
    create_build_plan(str(tmp_path), 'sess-mark', _sample_doc(), session=session)
    sessions['sess-mark'] = session
    queue: asyncio.Queue = asyncio.Queue()
    session.planning_nested_events_q = queue

    token = current_session_id.set('sess-mark')
    try:
        result = mark_build_plan_steps_complete.invoke({'step_ids': ['step-1']})
    finally:
        current_session_id.reset(token)
    assert 'Marked complete' in result
    parsed = parse_action_steps((tmp_path / session.active_build_plan_path).read_text(encoding='utf-8'))
    assert parsed[0]['complete'] is True

    assert not queue.empty()
    _tag, ev = queue.get_nowait()
    assert ev.get('event') == 'planner_progress'
    planner = ev.get('data', {}).get('planner', {})
    assert planner.get('phase') == 'executing'
    assert planner['steps'][0]['state'] == 'complete'
