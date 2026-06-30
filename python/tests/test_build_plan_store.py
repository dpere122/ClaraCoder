from __future__ import annotations

from pathlib import Path

import pytest

from nemo_backend.build_plan_store import (
    BuildPlanModel,
    cancel_build_plan,
    create_build_plan,
    get_active_plan,
    mark_steps_complete,
    parse_action_steps,
    render_build_plan_md,
)
from nemo_backend.domain import SessionState


def _sample_doc(**overrides: object) -> BuildPlanModel:
    base = {
        'title': 'Test plan',
        'task': 'Add feature',
        'current_implementation': 'Nothing yet',
        'files_to_change': ['src/a.ts — wire handler'],
        'action_steps': ['Implement handler', 'Add tests'],
    }
    base.update(overrides)
    return BuildPlanModel(**base)


def test_render_build_plan_md_includes_sections_and_step_ids() -> None:
    md = render_build_plan_md(_sample_doc())
    assert '# Build Plan: Test plan' in md
    assert '## Task' in md
    assert '## Action Steps' in md
    assert '<!-- step-id: step-1 -->' in md
    assert '- [ ] Implement handler' in md


def test_parse_action_steps_reads_checkbox_state() -> None:
    md = render_build_plan_md(_sample_doc())
    steps = parse_action_steps(md)
    assert [s['id'] for s in steps] == ['step-1', 'step-2']
    assert steps[0]['complete'] is False


def test_mark_steps_complete_flips_checkboxes(tmp_path: Path) -> None:
    session = SessionState(workspace_path=str(tmp_path))
    record = create_build_plan(str(tmp_path), 'sess-1', _sample_doc(), session=session)
    updated = mark_steps_complete(str(tmp_path), record, ['step-1'])
    assert updated[0]['complete'] is True
    assert updated[1]['complete'] is False
    text = (tmp_path / record.relative_path).read_text(encoding='utf-8')
    assert '- [x] Implement handler' in text


def test_create_build_plan_evicts_old_complete_entries(tmp_path: Path) -> None:
    for i in range(6):
        doc = _sample_doc(title=f'Plan {i}')
        create_build_plan(str(tmp_path), f'sess-{i}', doc)
    index_path = tmp_path / '.nemo' / 'build-plans' / 'index.json'
    assert index_path.is_file()
    md_files = list((tmp_path / '.nemo' / 'build-plans').glob('plan-*.md'))
    assert len(md_files) <= 5


def test_cancel_build_plan_deletes_file_and_clears_session(tmp_path: Path) -> None:
    session = SessionState(workspace_path=str(tmp_path))
    record = create_build_plan(str(tmp_path), 'sess-x', _sample_doc(), session=session)
    assert session.active_build_plan_id == record.id
    assert cancel_build_plan(session, record.id)
    assert session.active_build_plan_id == ''
    assert not (tmp_path / record.relative_path).exists()


def test_mark_steps_complete_rejects_unknown_ids(tmp_path: Path) -> None:
    session = SessionState(workspace_path=str(tmp_path))
    record = create_build_plan(str(tmp_path), 'sess-y', _sample_doc(), session=session)
    with pytest.raises(ValueError, match='Unknown step id'):
        mark_steps_complete(str(tmp_path), record, ['step-99'])


def test_get_active_plan_falls_back_to_registry_by_chat_session_id(tmp_path: Path) -> None:
    session = SessionState(workspace_path=str(tmp_path))
    record = create_build_plan(str(tmp_path), 'sess-z', _sample_doc(), session=session)
    session.active_build_plan_id = ''
    session.active_build_plan_path = ''

    resolved = get_active_plan(session, chat_session_id='sess-z')

    assert resolved is not None
    assert resolved.id == record.id
    assert session.active_build_plan_id == record.id
