from __future__ import annotations

from pathlib import Path

from clara_coder_backend.plan.build_plan_store import ActionStep, BuildPlanModel, FileChangeEntry
from clara_coder_backend.plan.plan_path_check import (
    PATH_CLARIFY,
    PATH_CREATE,
    apply_path_answers,
    verify_plan_paths,
)


def _plan(*entries: FileChangeEntry) -> BuildPlanModel:
    return BuildPlanModel(
        title='Plan',
        task='Task',
        current_implementation='',
        files_to_change=list(entries),
        action_steps=[ActionStep(id='step-1', goal='Work', files_touched=[e.path for e in entries])],
    )


def _touch(root: Path, rel: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('', encoding='utf-8')


def test_existing_paths_need_no_question(tmp_path: Path) -> None:
    _touch(tmp_path, 'src/app.ts')
    plan = _plan(FileChangeEntry(path='./src/app.ts', operation='modify'))
    check = verify_plan_paths(plan, str(tmp_path))
    assert check.questions == []
    assert not check.changed


def test_create_entries_are_not_checked(tmp_path: Path) -> None:
    check = verify_plan_paths(_plan(FileChangeEntry(path='src/new.ts', operation='create')), str(tmp_path))
    assert check.questions == []


def test_unique_name_match_is_corrected_everywhere(tmp_path: Path) -> None:
    _touch(tmp_path, 'src/server/router.ts')
    plan = _plan(FileChangeEntry(path='src/router.ts', operation='modify'))
    check = verify_plan_paths(plan, str(tmp_path))
    assert check.questions == []
    assert plan.files_to_change[0].path == 'src/server/router.ts'
    assert plan.action_steps[0].files_touched == ['src/server/router.ts']
    assert any('Path corrected' in a for a in plan.assumptions)


def test_closest_parent_dir_wins_without_asking(tmp_path: Path) -> None:
    _touch(tmp_path, 'app/server/router.ts')
    _touch(tmp_path, 'lib/router.ts')
    plan = _plan(FileChangeEntry(path='src/server/router.ts', operation='modify'))
    check = verify_plan_paths(plan, str(tmp_path))
    assert check.questions == []
    assert plan.files_to_change[0].path == 'app/server/router.ts'


def test_ambiguous_name_asks_with_real_paths(tmp_path: Path) -> None:
    _touch(tmp_path, 'api/router.ts')
    _touch(tmp_path, 'web/router.ts')
    plan = _plan(FileChangeEntry(path='src/router.ts', operation='modify'))
    check = verify_plan_paths(plan, str(tmp_path))
    assert len(check.questions) == 1
    assert set(check.questions[0].options) == {'api/router.ts', 'web/router.ts'}

    outcome = apply_path_answers(plan, check, {check.questions[0].id: 'web/router.ts'}, str(tmp_path))
    assert outcome.clarify == [] and not outcome.needs_replan
    assert plan.files_to_change[0].path == 'web/router.ts'


def test_missing_delete_is_dropped(tmp_path: Path) -> None:
    plan = _plan(FileChangeEntry(path='src/gone.ts', operation='delete'))
    check = verify_plan_paths(plan, str(tmp_path))
    assert check.questions == []
    assert plan.files_to_change == []
    assert plan.action_steps[0].files_touched == []


def test_missing_modify_asks_create_or_clarify(tmp_path: Path) -> None:
    plan = _plan(FileChangeEntry(path='src/router.ts', operation='modify'))
    check = verify_plan_paths(plan, str(tmp_path))
    qid = check.questions[0].id
    assert check.questions[0].options == [PATH_CREATE, PATH_CLARIFY]

    created = apply_path_answers(plan, check, {qid: PATH_CREATE}, str(tmp_path))
    assert created.clarify == []
    assert plan.files_to_change[0].operation == 'create'

    clarify = apply_path_answers(_plan(FileChangeEntry(path='src/router.ts')), check, {qid: PATH_CLARIFY}, str(tmp_path))
    assert clarify.clarify == ['src/router.ts']


def test_free_text_that_is_not_a_path_goes_to_the_planner(tmp_path: Path) -> None:
    plan = _plan(FileChangeEntry(path='src/router.ts', operation='modify'))
    check = verify_plan_paths(plan, str(tmp_path))
    outcome = apply_path_answers(plan, check, {check.questions[0].id: 'the one the API uses'}, str(tmp_path))
    assert outcome.needs_replan


def test_no_workspace_skips_the_check() -> None:
    check = verify_plan_paths(_plan(FileChangeEntry(path='src/router.ts')), '')
    assert check.questions == []


def test_backticked_paths_from_markdown_are_found_on_disk(tmp_path: Path) -> None:
    """Regression: planners wrap paths in backticks; that must not read as a missing file."""
    from clara_coder_backend.plan.build_plan_store import parse_build_plan_md

    _touch(tmp_path, 'src/ui/inventoryUI.ts')
    _touch(tmp_path, 'src/ui/hud.ts')
    md = (
        '# Build Plan: Icons\n\n## Task\nBigger icons.\n\n## Current Implementation\nFlat sprites.\n\n'
        '## File Changes\n'
        '- [modify] `src/ui/inventoryUI.ts` — cursor canvases 16→32\n'
        '- [modify] `src/ui/hud.ts:80`: replace the literal clear\n\n'
        '## Action Steps\n<!-- step-id: step-1 -->\n- [ ] Resize canvases\n'
        '  - **Files:** `src/ui/hud.ts`, `src/ui/inventoryUI.ts:144, 178`\n'
    )
    plan = parse_build_plan_md(md)
    assert [e.path for e in plan.files_to_change] == ['src/ui/inventoryUI.ts', 'src/ui/hud.ts']
    assert plan.files_to_change[1].rationale == 'replace the literal clear'
    assert plan.action_steps[0].files_touched == ['src/ui/hud.ts', 'src/ui/inventoryUI.ts']
    check = verify_plan_paths(plan, str(tmp_path))
    assert check.questions == []
    assert not check.changed
