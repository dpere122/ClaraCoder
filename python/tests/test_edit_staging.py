"""Dedicated staging tools, Black, code review tools, and cleanup."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest

from nemo_backend.agents.specialists.review_tools import (
    _materialize_staged_python_files,
    approve_staged_workspace_edit,
    diff_staged_edit_against_baseline,
    finalize_staged_transfer_after_hitl,
    format_staging_file_black,
    list_staged_edits,
    read_staged_edit,
    reject_staged_workspace_edit,
    search_staged_edits,
    transfer_staged_file_to_workspace,
)
from nemo_backend.domain import EditStagingEntry, RuntimeToolsConfig
from nemo_backend.edit_staging import (
    begin_planner_graph_staging_session,
    copy_workspace_into_snapshot,
    discard_all_session_stagings,
    get_active_planner_snapshot_root,
    get_staging_root,
    is_code_review_extension,
)
from nemo_backend.edit_tool import apply_workspace_full_file
from nemo_backend.staging_edit_tools import (
    stage_create_file,
    stage_line_range_edit,
    stage_snippet_edit,
    stage_workspace_file_overwrite,
)
from nemo_backend.search_backend import SearchLineMatch
from nemo_backend.state import current_session_id, get_session, runtime_config


@pytest.fixture()
def staging_env():
    saved_staging = os.environ.get('NEMO_STAGING_DIR')
    saved_tools = runtime_config.tools

    td = tempfile.TemporaryDirectory()
    td_path = Path(td.name)
    staging_root = td_path / 'staging'
    staging_root.mkdir(parents=True)
    os.environ['NEMO_STAGING_DIR'] = str(staging_root)

    workspace = td_path / 'ws'
    workspace.mkdir()

    session_id = 'test-staging-session'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.workspace_path = str(workspace.resolve())
    session.pending_edit_stagings.clear()
    session.pending_diff_payload = None
    session.auto_apply_mode = False
    session.worker_apply_mode = True
    session.abort_event.clear()
    session.planning_nested_events_q = None

    runtime_config.tools = RuntimeToolsConfig(
        edit_tools_strict=False,
        max_file_read_lines=400,
        max_search_results=40,
    )

    class _Env:
        pass

    env = _Env()
    env.staging_root = staging_root  # type: ignore[attr-defined]
    env.workspace = workspace  # type: ignore[attr-defined]
    env.session = session  # type: ignore[attr-defined]

    yield env

    current_session_id.reset(token)
    if saved_staging is None:
        os.environ.pop('NEMO_STAGING_DIR', None)
    else:
        os.environ['NEMO_STAGING_DIR'] = saved_staging
    runtime_config.tools = saved_tools
    td.cleanup()


def test_get_staging_root_uses_env(staging_env) -> None:
    assert get_staging_root() == staging_env.staging_root.resolve()


def test_is_code_review_extension(staging_env) -> None:
    assert is_code_review_extension('src/foo.py')
    assert is_code_review_extension('x.ts')
    assert is_code_review_extension('package.json')
    assert is_code_review_extension('config/app.yaml')
    assert not is_code_review_extension('README.md')


def test_copy_workspace_into_snapshot_skips_uncopyable_files(tmp_path, monkeypatch) -> None:
    """Regression: one bad file under e.g. .venv must not abort plan_and_modify snapshot seed."""
    from shutil import copy2 as real_copy2

    from nemo_backend import edit_staging as edit_staging_mod

    ws = tmp_path / 'ws'
    ws.mkdir()
    (ws / 'good.txt').write_text('ok', encoding='utf-8')
    (ws / 'bad.txt').write_text('x', encoding='utf-8')
    snap = tmp_path / 'snap'

    def copy2_patched(src, dst, *, follow_symlinks=True):
        if src.name == 'bad.txt':
            raise OSError('simulated copy failure')
        return real_copy2(src, dst, follow_symlinks=follow_symlinks)

    monkeypatch.setattr(edit_staging_mod, 'copy2', copy2_patched)
    copy_workspace_into_snapshot(ws, snap)
    assert (snap / 'good.txt').read_text(encoding='utf-8') == 'ok'
    assert not (snap / 'bad.txt').exists()


def test_stage_create_file_stages_python(staging_env) -> None:
    ws = staging_env.workspace
    session = staging_env.session
    (ws / 'mod.py').write_text('x=1\n', encoding='utf-8')
    out = stage_create_file.invoke(
        {
            'relative_path': 'mod.py',
            'new_content': 'x = 1\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    assert 'for review' in out.lower()
    assert 'mod.py' in session.pending_edit_stagings
    entry = session.pending_edit_stagings['mod.py']
    assert Path(entry.temp_path).is_file()


def test_stage_create_file_stages_package_json(staging_env) -> None:
    ws = staging_env.workspace
    session = staging_env.session
    (ws / 'package.json').write_text('{}\n', encoding='utf-8')
    out = stage_create_file.invoke(
        {
            'relative_path': 'package.json',
            'new_content': '{"name": "x"}\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    assert 'for review' in out.lower()
    assert 'package.json' in session.pending_edit_stagings


def test_stage_create_file_non_code_stages(staging_env) -> None:
    ws = staging_env.workspace
    session = staging_env.session
    (ws / 'note.txt').write_text('hi\n', encoding='utf-8')
    out = stage_create_file.invoke(
        {
            'relative_path': 'note.txt',
            'new_content': 'hello\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    assert 'Tool error:' not in out
    assert 'for review' in out.lower()
    assert 'note.txt' in session.pending_edit_stagings
    assert (ws / 'note.txt').read_text(encoding='utf-8') == 'hi\n'


def test_general_edit_tool_goes_straight_to_diff_for_non_code(staging_env) -> None:
    """Direct workspace edit tools apply to non-code paths only (code paths use plan_and_modify)."""
    ws = staging_env.workspace
    session = staging_env.session
    (ws / 'notes.md').write_text('y=2\n', encoding='utf-8')
    out = apply_workspace_full_file.invoke(
        {
            'relative_path': 'notes.md',
            'new_content': 'y = 2\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    assert session.pending_edit_stagings == {}
    assert 'Proposed' in out


def test_stage_line_range_edit_stages_python(staging_env) -> None:
    ws = staging_env.workspace
    session = staging_env.session
    (ws / 'lr.py').write_text('line1\nline2\nline3\n', encoding='utf-8')
    out = stage_line_range_edit.invoke(
        {
            'relative_path': 'lr.py',
            'start_line': 2,
            'end_line': 2,
            'new_snippet': 'replaced\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    assert 'for review' in out.lower()
    assert 'lr.py' in session.pending_edit_stagings


def test_stage_line_range_edit_accepts_new_content_alias(staging_env) -> None:
    """Some models send line-range replacements as `new_content` instead of `new_snippet`."""
    ws = staging_env.workspace
    session = staging_env.session
    (ws / 'alias.py').write_text('line1\nline2\nline3\n', encoding='utf-8')
    out = stage_line_range_edit.invoke(
        {
            'relative_path': 'alias.py',
            'start_line': 2,
            'end_line': 2,
            'new_snippet': '',
            'new_content': 'replaced\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    assert 'for review' in out.lower()
    assert 'alias.py' in session.pending_edit_stagings


def test_stage_snippet_edit_stages_python(staging_env) -> None:
    ws = staging_env.workspace
    session = staging_env.session
    (ws / 'sn.py').write_text('alpha\nbeta\ngamma\n', encoding='utf-8')
    out = stage_snippet_edit.invoke(
        {
            'relative_path': 'sn.py',
            'old_snippet': 'beta',
            'new_snippet': 'BETA',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    assert 'for review' in out.lower()
    assert 'sn.py' in session.pending_edit_stagings


def test_stage_workspace_file_overwrite_stages_python(staging_env) -> None:
    ws = staging_env.workspace
    session = staging_env.session
    (ws / 'edit.py').write_text('value = 1\n', encoding='utf-8')
    out = stage_workspace_file_overwrite.invoke(
        {
            'relative_path': 'edit.py',
            'new_content': 'value = 2\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    assert 'for review' in out.lower()
    entry = session.pending_edit_stagings['edit.py']
    assert entry.old_text == 'value = 1\n'
    assert entry.merged_text == 'value = 2\n'


def test_stage_workspace_file_overwrite_requires_existing_file(staging_env) -> None:
    out = stage_workspace_file_overwrite.invoke(
        {
            'relative_path': 'missing.py',
            'new_content': 'value = 1\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    assert 'does not exist in the workspace' in out


def test_stage_workspace_file_overwrite_allows_staged_only_new_file(staging_env) -> None:
    session = staging_env.session
    created = stage_create_file.invoke(
        {
            'relative_path': 'staged_only.py',
            'new_content': 'value = 1\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    assert 'for review' in created.lower()
    first_entry = session.pending_edit_stagings['staged_only.py']

    out = stage_workspace_file_overwrite.invoke(
        {
            'relative_path': 'staged_only.py',
            'new_content': 'value = 2\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )

    assert 'updated staged draft' in out.lower()
    latest = session.pending_edit_stagings['staged_only.py']
    assert latest.old_text == ''
    assert latest.merged_text == 'value = 2\n'
    assert latest.temp_path == first_entry.temp_path


def test_begin_planner_graph_staging_session_copies_workspace_snapshot(staging_env) -> None:
    ws = staging_env.workspace
    session = staging_env.session
    (ws / '.gitignore').write_text('ignored_dir/\n', encoding='utf-8')
    (ws / 'pkg').mkdir()
    (ws / 'pkg' / 'module.py').write_text('value = 1\n', encoding='utf-8')
    (ws / 'ignored_dir').mkdir()
    (ws / 'ignored_dir' / 'secret.py').write_text('ignored = True\n', encoding='utf-8')

    graph_id = begin_planner_graph_staging_session(session, 'test-staging-session', ws)

    snapshot_root = get_active_planner_snapshot_root(session)
    assert graph_id == session.active_planner_graph_id
    assert snapshot_root is not None
    assert snapshot_root == Path(session.active_planner_snapshot_root).resolve()
    assert (snapshot_root / 'pkg' / 'module.py').read_text(encoding='utf-8') == 'value = 1\n'
    assert not (snapshot_root / 'ignored_dir').exists()


def test_stage_workspace_file_overwrite_uses_active_snapshot_baseline(staging_env) -> None:
    ws = staging_env.workspace
    session = staging_env.session
    target = ws / 'baseline.py'
    target.write_text('value = 1\n', encoding='utf-8')
    begin_planner_graph_staging_session(session, 'test-staging-session', ws)
    target.write_text('value = 999\n', encoding='utf-8')

    out = stage_workspace_file_overwrite.invoke(
        {
            'relative_path': 'baseline.py',
            'new_content': 'value = 2\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )

    assert 'for review' in out.lower()
    entry = session.pending_edit_stagings['baseline.py']
    assert entry.old_text == 'value = 1\n'
    assert entry.merged_text == 'value = 2\n'


def test_read_format_approve_reject(staging_env) -> None:
    ws = staging_env.workspace
    session = staging_env.session
    (ws / 'z.py').write_text('a=1\n', encoding='utf-8')
    stage_create_file.invoke(
        {
            'relative_path': 'z.py',
            'new_content': 'a=1\nb=2\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    r1 = read_staged_edit.invoke({'relative_path': 'z.py'})
    assert 'z.py' in r1
    assert 'b = 2' in r1
    fmt = format_staging_file_black.invoke({'relative_path': 'z.py'})
    assert 'Black' in fmt
    rej = reject_staged_workspace_edit.invoke({'relative_path': 'z.py', 'feedback': 'no'})
    assert 'Rejected' in rej
    assert 'z.py' in session.pending_edit_stagings
    assert Path(session.pending_edit_stagings['z.py'].temp_path).is_file()


def test_follow_up_workspace_overwrite_restarts_from_workspace_file(staging_env) -> None:
    ws = staging_env.workspace
    session = staging_env.session
    (ws / 'draft.py').write_text('def value():\n    return 0\n', encoding='utf-8')
    out = stage_workspace_file_overwrite.invoke(
        {
            'relative_path': 'draft.py',
            'new_content': 'def value():\n    return 1\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    assert 'for review' in out.lower()
    first_path = Path(session.pending_edit_stagings['draft.py'].temp_path)
    assert first_path.is_file()

    rej = reject_staged_workspace_edit.invoke({'relative_path': 'draft.py', 'feedback': 'return 2 instead'})
    assert 'Rejected' in rej
    assert session.pending_edit_stagings['draft.py'].temp_path == str(first_path)

    revised = stage_workspace_file_overwrite.invoke(
        {
            'relative_path': 'draft.py',
            'new_content': 'def value():\n    return 2\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    assert 'for review' in revised.lower()
    latest = session.pending_edit_stagings['draft.py']
    assert latest.old_text == 'def value():\n    return 0\n'
    assert Path(latest.temp_path).is_file()
    assert latest.temp_path == str(first_path)
    reread = read_staged_edit.invoke({'relative_path': 'draft.py', 'include_line_numbers': False})
    assert 'return 2' in reread


def test_staging_review_tools_stay_inside_staging_surface(staging_env) -> None:
    ws = staging_env.workspace
    (ws / 'multi.py').write_text('alpha\nbeta\ngamma\n', encoding='utf-8')
    stage_create_file.invoke(
        {
            'relative_path': 'multi.py',
            'new_content': 'alpha\nBETA\ngamma\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    listed = list_staged_edits.invoke({})
    assert 'multi.py' in listed
    excerpt = read_staged_edit.invoke({'relative_path': 'multi.py', 'start_line': 2, 'end_line': 2})
    assert '2 │ BETA' in excerpt
    hits = search_staged_edits.invoke({'query': 'BETA', 'relative_path': 'multi.py'})
    assert '[multi.py line 2]' in hits


def test_diff_staged_edit_against_baseline_unified_diff(staging_env) -> None:
    ws = staging_env.workspace
    (ws / 'delta.py').write_text('a\nb\nc\n', encoding='utf-8')
    stage_workspace_file_overwrite.invoke(
        {
            'relative_path': 'delta.py',
            'new_content': 'a\nB\nc\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    out = diff_staged_edit_against_baseline.invoke({'relative_path': 'delta.py'})
    assert 'workspace_baseline/' in out
    assert 'staged_draft/' in out
    assert 'B' in out


def test_diff_staged_edit_against_baseline_identical_reports_no_changes(staging_env) -> None:
    ws = staging_env.workspace
    content = 'same\nlines\n'
    (ws / 'same.py').write_text(content, encoding='utf-8')
    stage_workspace_file_overwrite.invoke(
        {
            'relative_path': 'same.py',
            'new_content': content,
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    out = diff_staged_edit_against_baseline.invoke({'relative_path': 'same.py'})
    assert 'identical' in out.lower() or 'no textual changes' in out.lower()


def test_search_staged_edits_uses_grep_when_available(staging_env, monkeypatch: pytest.MonkeyPatch) -> None:
    ws = staging_env.workspace
    (ws / 'multi.py').write_text('alpha\nbeta\ngamma\n', encoding='utf-8')
    stage_create_file.invoke(
        {
            'relative_path': 'multi.py',
            'new_content': 'alpha\nBETA\ngamma\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    seen: list[tuple[str, ...]] = []

    def _fake_run_grep_line_search(query: str, candidates, **kwargs):
        del kwargs
        seen.append(tuple(candidate.display_path for candidate in candidates))
        assert query == 'BETA'
        return [SearchLineMatch(display_path='multi.py', line_number=2)]

    monkeypatch.setattr(
        'nemo_backend.agents.specialists.review_tools.run_grep_line_search',
        _fake_run_grep_line_search,
    )

    hits = search_staged_edits.invoke({'query': 'BETA', 'relative_path': 'multi.py'})

    assert seen == [('multi.py',)]
    assert '[multi.py line 2] │ BETA' in hits


def test_approve_sets_diff_payload(staging_env) -> None:
    ws = staging_env.workspace
    session = staging_env.session
    (ws / 'q.py').write_text('n=0\n', encoding='utf-8')
    stage_create_file.invoke(
        {
            'relative_path': 'q.py',
            'new_content': 'n = 0\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    session.auto_apply_mode = False
    out = approve_staged_workspace_edit.invoke({'relative_path': 'q.py'})
    assert 'human confirmation' in out.lower()
    assert (ws / 'q.py').read_text(encoding='utf-8') == 'n=0\n'
    assert session.pending_staged_transfer_hitl is not None
    assert session.pending_staged_transfer_hitl.relative_path == 'q.py'
    assert session.pending_diff_payload is not None
    assert session.pending_diff_payload.get('stagedTransferHitl') is True
    assert 'q.py' in session.pending_edit_stagings
    assert session.pending_edit_stagings['q.py'].workspace_applied is False

    msg = finalize_staged_transfer_after_hitl(session, 'confirm', '')
    assert 'User confirmed' in msg
    assert (ws / 'q.py').read_text(encoding='utf-8') == 'n = 0\n'
    assert session.pending_edit_stagings['q.py'].workspace_applied is True
    assert session.pending_staged_transfer_hitl is None


def test_transfer_tool_sets_diff_payload(staging_env) -> None:
    ws = staging_env.workspace
    session = staging_env.session
    (ws / 'transfer.py').write_text('x=1\n', encoding='utf-8')
    stage_create_file.invoke(
        {
            'relative_path': 'transfer.py',
            'new_content': 'x = 1\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    out = transfer_staged_file_to_workspace.invoke({'relative_path': 'transfer.py'})
    assert 'transfer.py' in out
    assert 'human confirmation' in out.lower()
    assert (ws / 'transfer.py').read_text(encoding='utf-8') == 'x=1\n'
    assert session.pending_staged_transfer_hitl is not None
    assert session.pending_diff_payload is not None
    assert 'transfer.py' in session.pending_edit_stagings
    assert session.pending_edit_stagings['transfer.py'].workspace_applied is False

    finalize_staged_transfer_after_hitl(session, 'confirm', '')
    assert (ws / 'transfer.py').read_text(encoding='utf-8') == 'x = 1\n'
    assert session.pending_edit_stagings['transfer.py'].workspace_applied is True


def test_transfer_writes_immediately_when_auto_apply(staging_env) -> None:
    ws = staging_env.workspace
    session = staging_env.session
    session.auto_apply_mode = True
    (ws / 'auto.py').write_text('z=0\n', encoding='utf-8')
    stage_create_file.invoke(
        {
            'relative_path': 'auto.py',
            'new_content': 'z = 0\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    out = transfer_staged_file_to_workspace.invoke({'relative_path': 'auto.py'})
    assert 'real workspace' in out.lower()
    assert (ws / 'auto.py').read_text(encoding='utf-8') == 'z = 0\n'
    assert session.pending_staged_transfer_hitl is None
    assert session.pending_edit_stagings['auto.py'].workspace_applied is True


def test_staged_transfer_re_review_skips_disk_write(staging_env) -> None:
    ws = staging_env.workspace
    session = staging_env.session
    (ws / 'rerev.py').write_text('a=1\n', encoding='utf-8')
    stage_create_file.invoke(
        {
            'relative_path': 'rerev.py',
            'new_content': 'a = 2\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    transfer_staged_file_to_workspace.invoke({'relative_path': 'rerev.py'})
    msg = finalize_staged_transfer_after_hitl(session, 're_review', 'needs more tests')
    assert 're-review' in msg.lower()
    assert (ws / 'rerev.py').read_text(encoding='utf-8') == 'a=1\n'
    assert session.pending_edit_stagings['rerev.py'].workspace_applied is False
    assert session.pending_staged_transfer_hitl is None


def test_approved_staged_entry_is_hidden_from_review_tools(staging_env) -> None:
    ws = staging_env.workspace
    session = staging_env.session
    (ws / 'hidden.py').write_text('value=1\n', encoding='utf-8')
    stage_workspace_file_overwrite.invoke(
        {
            'relative_path': 'hidden.py',
            'new_content': 'value = 2\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )

    out = transfer_staged_file_to_workspace.invoke({'relative_path': 'hidden.py'})
    assert 'human confirmation' in out.lower()
    finalize_staged_transfer_after_hitl(session, 'confirm', '')
    assert session.pending_edit_stagings['hidden.py'].workspace_applied is True
    assert list_staged_edits.invoke({}) == 'No staged edits are available.'
    reread = read_staged_edit.invoke({'relative_path': 'hidden.py'})
    assert 'already approved in the workspace' in reread
    assert 'read_workspace_file' in reread


def test_mutation_tools_blocked_when_editor_off(staging_env) -> None:
    session = staging_env.session
    session.worker_apply_mode = False
    assert 'Editor mode is off' in apply_workspace_full_file.invoke(
        {'relative_path': 'a.py', 'new_content': 'x = 1\n'}
    )
    assert 'Editor mode is off' in stage_create_file.invoke(
        {'relative_path': 'b.py', 'new_content': 'x = 1\n'}
    )


def test_discard_all_session_stagings(staging_env) -> None:
    session = staging_env.session
    p = staging_env.staging_root / 'f.txt'
    p.write_text('x', encoding='utf-8')
    session.pending_edit_stagings['x.py'] = EditStagingEntry(
        temp_path=str(p),
        old_text='',
        merged_text='x',
        disk_encoding='utf-8',
        disk_newline='lf',
        edit_mode='full-file',
    )
    discard_all_session_stagings(session)
    assert session.pending_edit_stagings == {}
    assert not p.exists()


def test_reject_staged_workspace_edit_rolls_back_materialized_workspace_files(staging_env) -> None:
    ws = staging_env.workspace
    session = staging_env.session
    (ws / 'python' / 'nemo_backend').mkdir(parents=True)
    target = ws / 'python' / 'nemo_backend' / 'main.py'
    target.write_text('VALUE = 1\n', encoding='utf-8')
    stage_workspace_file_overwrite.invoke(
        {
            'relative_path': 'python/nemo_backend/main.py',
            'new_content': 'VALUE = 2\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    assert session.pending_edit_stagings['python/nemo_backend/main.py'].merged_text == 'VALUE = 2\n'

    ok, detail = _materialize_staged_python_files(
        session,
        [('python/nemo_backend/main.py', session.pending_edit_stagings['python/nemo_backend/main.py'])],
    )
    assert ok is True
    assert detail == ''
    assert target.read_text(encoding='utf-8') == 'VALUE = 2\n'

    out = reject_staged_workspace_edit.invoke(
        {'relative_path': 'python/nemo_backend/main.py', 'feedback': 'fix failing test'}
    )
    assert 'Rejected staged edit' in out
    assert target.read_text(encoding='utf-8') == 'VALUE = 1\n'
