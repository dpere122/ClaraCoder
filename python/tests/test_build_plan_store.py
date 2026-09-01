from __future__ import annotations

from pathlib import Path

import pytest

from clara_coder_backend.plan.build_plan_store import (
    ActionStep,
    BuildPlanModel,
    FileChangeEntry,
    OpenQuestion,
    cancel_build_plan,
    create_build_plan,
    create_build_plan_draft,
    finalize_build_plan_draft,
    get_active_plan,
    mark_steps_complete,
    parse_action_steps,
    parse_build_plan_md,
    render_build_plan_md,
)
from clara_coder_backend.domain import SessionState


def _sample_doc(**overrides: object) -> BuildPlanModel:
    base = {
        'title': 'Test plan',
        'task': 'Add feature',
        'current_implementation': 'Nothing yet',
        'files_to_change': [
            FileChangeEntry(path='src/a.ts', operation='modify', rationale='wire handler'),
        ],
        'action_steps': [
            ActionStep(id='step-1', goal='Implement handler'),
            ActionStep(id='step-2', goal='Add tests'),
        ],
    }
    base.update(overrides)
    return BuildPlanModel(**base)


def test_parse_build_plan_md_round_trips_rendered_document() -> None:
    doc = _sample_doc()
    md = render_build_plan_md(doc)
    parsed = parse_build_plan_md(md)
    assert parsed.title == doc.title
    assert parsed.task == doc.task
    assert parsed.current_implementation == doc.current_implementation
    assert parsed.files_to_change == doc.files_to_change
    assert [s.goal for s in parsed.action_steps] == [s.goal for s in doc.action_steps]
    assert [s.id for s in parsed.action_steps] == ['step-1', 'step-2']


def test_create_build_plan_draft_writes_stub_and_registers_drafting(tmp_path: Path) -> None:
    session = SessionState(workspace_path=str(tmp_path))
    record = create_build_plan_draft(str(tmp_path), 'sess-draft', session=session)
    assert record.status == 'drafting'
    assert session.active_build_plan_id == record.id
    text = (tmp_path / record.relative_path).read_text(encoding='utf-8')
    assert text.startswith('# Build Plan')


def test_finalize_build_plan_draft_promotes_to_active(tmp_path: Path) -> None:
    session = SessionState(workspace_path=str(tmp_path))
    record = create_build_plan_draft(str(tmp_path), 'sess-final', session=session)
    md = render_build_plan_md(_sample_doc())
    finalized = finalize_build_plan_draft(str(tmp_path), record, md)
    assert finalized.status == 'active'
    assert finalized.title == 'Test plan'


def test_render_build_plan_md_includes_sections_and_step_ids() -> None:
    md = render_build_plan_md(_sample_doc())
    assert '# Build Plan: Test plan' in md
    assert '## Task' in md
    assert '## File Changes' in md
    assert '- [modify] src/a.ts — wire handler' in md
    assert '## Action Steps' in md
    assert '<!-- step-id: step-1 -->' in md
    assert '- [ ] Implement handler' in md


def test_file_changes_round_trip_create_modify_delete() -> None:
    doc = _sample_doc(
        files_to_change=[
            FileChangeEntry(path='src/new.ts', operation='create', rationale='add module'),
            FileChangeEntry(path='src/a.ts', operation='modify', rationale='wire handler'),
            FileChangeEntry(path='src/old.ts', operation='delete', rationale='remove unused'),
        ]
    )
    parsed = parse_build_plan_md(render_build_plan_md(doc))
    assert [(e.operation, e.path, e.rationale) for e in parsed.files_to_change] == [
        ('create', 'src/new.ts', 'add module'),
        ('modify', 'src/a.ts', 'wire handler'),
        ('delete', 'src/old.ts', 'remove unused'),
    ]


def test_parse_legacy_files_to_change_section_defaults_to_modify() -> None:
    md = (
        '# Build Plan: Legacy\n\n## Task\nDo\n\n## Current Implementation\nNone\n\n'
        '## Files to Change\n'
        '- src/a.ts — wire handler\n'
        '- [delete] src/old.ts — remove unused\n\n'
        '## Action Steps\n<!-- step-id: step-1 -->\n- [ ] Implement\n'
    )
    parsed = parse_build_plan_md(md)
    assert [(e.operation, e.path, e.rationale) for e in parsed.files_to_change] == [
        ('modify', 'src/a.ts', 'wire handler'),
        ('delete', 'src/old.ts', 'remove unused'),
    ]


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
    index_path = tmp_path / '.clara' / 'build-plans' / 'index.json'
    assert index_path.is_file()
    md_files = list((tmp_path / '.clara' / 'build-plans').glob('plan-*.md'))
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


def test_enriched_schema_round_trips_through_markdown() -> None:
    doc = BuildPlanModel(
        title='Enriched',
        task='Do the thing',
        current_implementation='Partial',
        files_to_change=[
            FileChangeEntry(path='src/a.ts', operation='modify', rationale='wire it'),
        ],
        assumptions=['Module X is stable'],
        open_questions=[OpenQuestion(id='q-1', prompt='Use REST or gRPC?', options=['REST', 'gRPC'])],
        rollback_notes='Revert src/a.ts and drop the table.',
        definition_of_done=['Endpoint returns 200', 'Tests green'],
        action_steps=[
            ActionStep(
                id='step-1',
                goal='Implement handler',
                files_touched=['src/a.ts', 'src/b.ts'],
                approach='Add handler in a.ts, wire from b.ts',
                acceptance_criteria=['returns 200 for valid input', '400 for invalid input'],
                verification='pytest tests/test_a.py',
                risks=['touches shared middleware'],
            ),
        ],
    )
    md = render_build_plan_md(doc)
    parsed = parse_build_plan_md(md)

    assert parsed.assumptions == ['Module X is stable']
    assert parsed.rollback_notes == 'Revert src/a.ts and drop the table.'
    assert parsed.definition_of_done == ['Endpoint returns 200', 'Tests green']

    assert len(parsed.open_questions) == 1
    q = parsed.open_questions[0]
    assert q.id == 'q-1'
    assert q.prompt == 'Use REST or gRPC?'
    assert q.options == ['REST', 'gRPC']

    assert len(parsed.action_steps) == 1
    step = parsed.action_steps[0]
    assert step.goal == 'Implement handler'
    assert step.files_touched == ['src/a.ts', 'src/b.ts']
    assert step.approach == 'Add handler in a.ts, wire from b.ts'
    assert step.acceptance_criteria == ['returns 200 for valid input', '400 for invalid input']
    assert step.verification == 'pytest tests/test_a.py'
    assert step.risks == ['touches shared middleware']


def test_parse_action_steps_captures_enriched_details() -> None:
    doc = BuildPlanModel(
        title='x',
        task='x',
        current_implementation='',
        files_to_change=[],
        action_steps=[
            ActionStep(
                id='step-1',
                goal='Implement handler',
                files_touched=['src/a.ts'],
                acceptance_criteria=['returns 200'],
                verification='pytest tests/x',
                risks=['shared code'],
            ),
        ],
    )
    steps = parse_action_steps(render_build_plan_md(doc))
    assert steps[0]['files_touched'] == ['src/a.ts']
    assert steps[0]['acceptance_criteria'] == ['returns 200']
    assert steps[0]['verification'] == 'pytest tests/x'
    assert steps[0]['risks'] == ['shared code']


def test_parse_open_questions_handles_numbered_and_star_bullets() -> None:
    md = (
        '# Build Plan: X\n\n## Task\nDo\n\n## Current Implementation\nNone\n\n'
        '## Files to Change\n- src/a.ts\n\n'
        '## Open Questions\n'
        '1. Should we use REST or gRPC?\n   - REST\n   - gRPC\n'
        '2. Add tests now?\n   * Yes\n   * No\n\n'
        '## Action Steps\n<!-- step-id: step-1 -->\n- [ ] Implement\n'
    )
    parsed = parse_build_plan_md(md)
    assert [q.prompt for q in parsed.open_questions] == ['Should we use REST or gRPC?', 'Add tests now?']
    assert parsed.open_questions[0].options == ['REST', 'gRPC']
    assert parsed.open_questions[1].options == ['Yes', 'No']


def test_parse_open_questions_merges_flat_statement_options() -> None:
    """LLM often lists options flat (no indent) after a '?' question — merge them as options."""
    md = (
        '# Build Plan: X\n\n## Task\nDo\n\n## Current Implementation\nNone\n\n'
        '## Files to Change\n- src/a.ts\n\n'
        '## Open Questions\n'
        "1. Should the Total section update in real-time as the user types, or only after they click 'Submit'?\n"
        "2. Only after 'Submit' (matches current BudgetInput behavior of logging on submit).\n"
        '3. Real-time as the user types.\n\n'
        '## Action Steps\n<!-- step-id: step-1 -->\n- [ ] Implement\n'
    )
    parsed = parse_build_plan_md(md)
    assert len(parsed.open_questions) == 1
    assert parsed.open_questions[0].prompt.startswith('Should the Total section update')
    assert parsed.open_questions[0].options == [
        "Only after 'Submit' (matches current BudgetInput behavior of logging on submit).",
        'Real-time as the user types.',
    ]


def test_parse_open_questions_strips_question_and_option_labels() -> None:
    md = (
        '# Build Plan: X\n\n## Task\nDo\n\n## Current Implementation\nNone\n\n'
        '## Files to Change\n- src/a.ts\n\n'
        '## Open Questions\n'
        '- Question: How should the total value be calculated?\n'
        '  - Option 1: Pass it as an input attribute\n'
        '  - Option 2: Fetch from store\n'
        '- Discovery: Did not confirm the path src/foo.ts\n'
        '  - Proceed with this assumption\n'
        '  - Cancel and let me clarify\n\n'
        '## Action Steps\n<!-- step-id: step-1 -->\n- [ ] Implement\n'
    )
    parsed = parse_build_plan_md(md)
    assert [q.prompt for q in parsed.open_questions] == [
        'How should the total value be calculated?',
        'Did not confirm the path src/foo.ts',
    ]
    assert parsed.open_questions[0].options == ['Pass it as an input attribute', 'Fetch from store']
    assert parsed.open_questions[1].options == ['Proceed with this assumption', 'Cancel and let me clarify']


def test_parse_open_questions_strips_bold_prompts() -> None:
    md = (
        '# Build Plan: X\n\n## Task\nDo\n\n## Current Implementation\nNone\n\n'
        '## Files to Change\n- src/a.ts\n\n'
        '## Open Questions\n- **Which protocol?** REST or gRPC?\n  * REST\n  * gRPC\n\n'
        '## Action Steps\n<!-- step-id: step-1 -->\n- [ ] Implement\n'
    )
    parsed = parse_build_plan_md(md)
    assert len(parsed.open_questions) == 1
    assert parsed.open_questions[0].prompt == 'Which protocol? REST or gRPC?'
    assert parsed.open_questions[0].options == ['REST', 'gRPC']


def test_mark_steps_complete_preserves_enriched_details(tmp_path: Path) -> None:
    session = SessionState(workspace_path=str(tmp_path))
    doc = BuildPlanModel(
        title='x',
        task='x',
        current_implementation='',
        files_to_change=[],
        action_steps=[
            ActionStep(id='step-1', goal='Implement handler', verification='pytest tests/x'),
        ],
    )
    record = create_build_plan(str(tmp_path), 'sess-p', doc, session=session)
    updated = mark_steps_complete(str(tmp_path), record, ['step-1'])
    assert updated[0]['complete'] is True
    assert updated[0]['verification'] == 'pytest tests/x'


def test_parse_action_steps_handles_checkboxes_without_step_id_markers() -> None:
    """LLMs often omit the ``<!-- step-id -->`` marker; checkboxes must still become steps."""
    md = (
        '# Build Plan: Demo\n\n'
        '## Action Steps\n'
        '- [ ] First milestone\n'
        '- [ ] Second milestone\n'
    )
    steps = parse_action_steps(md)
    assert [s['id'] for s in steps] == ['step-1', 'step-2']
    assert [s['text'] for s in steps] == ['First milestone', 'Second milestone']
    assert all(s['complete'] is False for s in steps)


def test_parse_build_plan_md_keeps_steps_when_markers_missing() -> None:
    """A plan whose only "flaw" is missing step-id comments must not parse as empty."""
    md = (
        '# Build Plan: Demo\n\n'
        '## Task\nDo the thing.\n\n'
        '## Action Steps\n'
        '- [ ] First milestone\n'
        '- [ ] Second milestone\n'
    )
    parsed = parse_build_plan_md(md)
    assert [s.goal for s in parsed.action_steps] == ['First milestone', 'Second milestone']


def test_mark_steps_complete_flips_checkboxes_without_step_id_markers(tmp_path: Path) -> None:
    session = SessionState(workspace_path=str(tmp_path))
    md = (
        '# Build Plan: Demo\n\n'
        '## Task\nDo the thing.\n\n'
        '## Action Steps\n'
        '- [ ] First milestone\n'
        '- [ ] Second milestone\n'
    )
    record = create_build_plan_draft(str(tmp_path), 'sess-m', session=session)
    finalize_build_plan_draft(str(tmp_path), record, md)
    updated = mark_steps_complete(str(tmp_path), record, ['step-2'])
    states = {row['id']: row['complete'] for row in updated}
    assert states == {'step-1': False, 'step-2': True}


def test_migrate_legacy_nemo_dir_rewrites_index_paths(tmp_path: Path) -> None:
    from clara_coder_backend.workspace.meta import migrate_legacy_workspace_meta_dir

    legacy = tmp_path / '.nemo' / 'build-plans'
    legacy.mkdir(parents=True)
    (legacy / 'plan-abc.md').write_text('# Plan\n', encoding='utf-8')
    (legacy / 'index.json').write_text(
        '[{"id": "plan-abc", "relativePath": ".nemo/build-plans/plan-abc.md", "status": "active"}]\n',
        encoding='utf-8',
    )
    migrate_legacy_workspace_meta_dir(tmp_path)
    assert not (tmp_path / '.nemo').exists()
    index = (tmp_path / '.clara' / 'build-plans' / 'index.json').read_text(encoding='utf-8')
    assert '.clara/build-plans/plan-abc.md' in index
    assert '.nemo/build-plans/' not in index
    assert (tmp_path / '.clara' / 'build-plans' / 'plan-abc.md').is_file()


def test_create_build_plan_uses_clara_dir_after_legacy_rename(tmp_path: Path) -> None:
    from clara_coder_backend.workspace.meta import migrate_legacy_workspace_meta_dir

    (tmp_path / '.nemo' / 'build-plans').mkdir(parents=True)
    migrate_legacy_workspace_meta_dir(tmp_path)
    record = create_build_plan(str(tmp_path), 'sess-1', _sample_doc())
    assert record.relative_path.startswith('.clara/build-plans/')
    assert (tmp_path / record.relative_path).is_file()

