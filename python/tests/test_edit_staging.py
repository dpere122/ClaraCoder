"""Dedicated staging tools, Black, code review tools, and cleanup."""

from __future__ import annotations

from pathlib import Path

import pytest

from clara_coder_backend.tools.review_tools import (
    _materialize_staged_python_files,
    diff_staged_edit_against_baseline,
    finalize_staged_transfer_after_hitl,
    format_staging_file_black,
    format_staging_file_prettier,
    list_staged_edits,
    read_staged_edit,
    reject_staged_workspace_edit,
    resolve_staged_transfer_batch_file,
    search_staged_edits,
    transfer_staged_file_to_workspace,
)
from clara_coder_backend.session.domain import EditStagingEntry, RuntimeToolsConfig
from clara_coder_backend.staging.edit_staging import (
    begin_staging_snapshot_session,
    copy_workspace_into_snapshot,
    discard_all_session_stagings,
    format_source_via_prettier,
    get_active_staging_snapshot_root,
    get_staging_root,
    is_code_review_extension,
    resolve_prettier_cli,
)
from clara_coder_backend.tools.edit import apply_workspace_full_file
from clara_coder_backend.tools.staging_edit import (
    stage_create_file,
    stage_line_range_edit,
    stage_snippet_edit,
    stage_workspace_file_overwrite,
)
from clara_coder_backend.workspace.search_backend import SearchLineMatch
from clara_coder_backend.session.state import current_session_id, get_session, runtime_config


def test_get_staging_root_uses_env(staging_env) -> None:
    assert get_staging_root() == staging_env.staging_root.resolve()


def test_is_code_review_extension(staging_env) -> None:
    assert is_code_review_extension('src/foo.py')
    assert is_code_review_extension('x.ts')
    assert is_code_review_extension('package.json')
    assert is_code_review_extension('config/app.yaml')
    assert not is_code_review_extension('README.md')


def test_resolve_prettier_cli_reads_package_bin(staging_env) -> None:
    ws = staging_env.workspace
    package_dir = ws / 'node_modules' / 'prettier'
    package_dir.mkdir(parents=True)
    cli = package_dir / 'bin' / 'prettier.cjs'
    cli.parent.mkdir(parents=True)
    cli.write_text('// prettier cli\n', encoding='utf-8')
    (package_dir / 'package.json').write_text('{"bin":{"prettier":"./bin/prettier.cjs"}}\n', encoding='utf-8')

    assert resolve_prettier_cli(ws) == cli.resolve()


def test_format_source_via_prettier_runs_cmd_shim_directly(monkeypatch, staging_env) -> None:
    from clara_coder_backend.staging import edit_staging as _es
    shim = staging_env.workspace / 'node_modules' / '.bin' / 'prettier.cmd'
    monkeypatch.setattr(_es, 'resolve_prettier_cli', lambda workspace_root: shim)
    monkeypatch.setattr(_es, '_resolve_node_executable', lambda: 'node')

    calls: list[list[str]] = []

    class _Proc:
        returncode = 0
        stdout = b'const x = 1;\n'
        stderr = b''

    def _run(args, **kwargs):
        del kwargs
        calls.append(args)
        return _Proc()

    monkeypatch.setattr(_es.subprocess, 'run', _run)

    formatted, err = format_source_via_prettier(
        'const x=1\n',
        workspace_root=staging_env.workspace,
        relative_posix='main.js',
    )

    assert err == ''
    assert formatted == 'const x = 1;\n'
    assert calls == [[str(shim), '--stdin-filepath', 'main.js']]


def test_format_source_via_prettier_runs_node_for_cjs_cli(monkeypatch, staging_env) -> None:
    from clara_coder_backend.staging import edit_staging as _es
    cli = staging_env.workspace / 'node_modules' / 'prettier' / 'bin' / 'prettier.cjs'
    monkeypatch.setattr(_es, 'resolve_prettier_cli', lambda workspace_root: cli)
    monkeypatch.setattr(_es, '_resolve_node_executable', lambda: 'node')

    calls: list[list[str]] = []

    class _Proc:
        returncode = 0
        stdout = b'const x = 1;\n'
        stderr = b''

    def _run(args, **kwargs):
        del kwargs
        calls.append(args)
        return _Proc()

    monkeypatch.setattr(_es.subprocess, 'run', _run)

    formatted, err = format_source_via_prettier(
        'const x=1\n',
        workspace_root=staging_env.workspace,
        relative_posix='main.js',
    )

    assert err == ''
    assert formatted == 'const x = 1;\n'
    assert calls == [['node', str(cli), '--stdin-filepath', 'main.js']]


def test_copy_workspace_into_snapshot_skips_uncopyable_files(tmp_path, monkeypatch) -> None:
    """Regression: one bad file under e.g. .venv must not abort staging snapshot seed."""
    from shutil import copy2 as real_copy2

    from clara_coder_backend.staging import edit_staging as edit_staging_mod
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
    """Direct workspace edit tools apply to non-code paths only (code paths use staging)."""
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
    assert 'LSP-style range' in out
    assert 'Replaced inclusive baseline lines: 2–2' in out
    assert 'Removed baseline text' in out and 'line2' in out
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
    assert 'Next partial edit on this path' in out
    assert 'read_staged_edit' in out


def test_stage_snippet_edit_new_content_alias(staging_env) -> None:
    ws = staging_env.workspace
    session = staging_env.session
    (ws / 'alias_snip.py').write_text('alpha\nbeta\ngamma\n', encoding='utf-8')
    out = stage_snippet_edit.invoke(
        {
            'relative_path': 'alias_snip.py',
            'old_snippet': 'beta',
            'new_snippet': '',
            'new_content': 'BETA',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    assert 'for review' in out.lower()
    entry = session.pending_edit_stagings['alias_snip.py']
    assert 'BETA' in entry.merged_text
    assert 'beta' not in entry.merged_text


def test_stage_snippet_edit_stale_disk_anchor_after_prior_stage_hints_read_staged_edit(staging_env) -> None:
    """Anchoring on disk text after a prior stage already changed those lines in the draft should point at read_staged_edit."""
    ws = staging_env.workspace
    (ws / 'stale.py').write_text('alpha\nbeta\ngamma\n', encoding='utf-8')
    first = stage_snippet_edit.invoke(
        {
            'relative_path': 'stale.py',
            'old_snippet': 'beta',
            'new_snippet': 'BETA',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    assert 'for review' in first.lower()

    # Second call still anchors on the *disk* text ('beta'); the draft now has 'BETA' instead.
    second = stage_snippet_edit.invoke(
        {
            'relative_path': 'stale.py',
            'old_snippet': 'beta',
            'new_snippet': 'nope',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    assert second.startswith('Tool error:')
    assert 'old_snippet not found' in second
    assert 'staged draft' in second
    assert 'read_staged_edit' in second
    assert 'not `read_workspace_file`' in second
    assert 'on-disk' in second and 'absent from the staged draft' in second


def test_stage_line_range_edit_past_draft_end_after_prior_stage_hints_read_staged_edit(staging_env) -> None:
    """A line-range anchored on the disk length should hint at the draft once a prior stage shrank it."""
    ws = staging_env.workspace
    (ws / 'shrink.py').write_text('line1\nline2\nline3\nline4\nline5\n', encoding='utf-8')
    first = stage_line_range_edit.invoke(
        {
            'relative_path': 'shrink.py',
            'start_line': 2,
            'end_line': 5,
            'new_snippet': '',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    assert 'for review' in first.lower()

    # Second call still uses the disk-based end_line (5), now past the end of the 1-line draft.
    second = stage_line_range_edit.invoke(
        {
            'relative_path': 'shrink.py',
            'start_line': 1,
            'end_line': 5,
            'new_snippet': 'x',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    assert second.startswith('Tool error:')
    assert 'past end of file' in second
    assert 'staged draft' in second
    assert 'read_staged_edit' in second


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


def test_begin_staging_snapshot_session_copies_workspace_snapshot(staging_env) -> None:
    ws = staging_env.workspace
    session = staging_env.session
    (ws / '.gitignore').write_text('ignored_dir/\n', encoding='utf-8')
    (ws / 'pkg').mkdir()
    (ws / 'pkg' / 'module.py').write_text('value = 1\n', encoding='utf-8')
    (ws / 'ignored_dir').mkdir()
    (ws / 'ignored_dir' / 'secret.py').write_text('ignored = True\n', encoding='utf-8')

    snapshot_id = begin_staging_snapshot_session(session, 'test-staging-session', ws)

    snapshot_root = get_active_staging_snapshot_root(session)
    assert snapshot_id == session.active_staging_snapshot_id
    assert snapshot_root is not None
    assert snapshot_root == Path(session.active_staging_snapshot_root).resolve()
    assert (snapshot_root / 'pkg' / 'module.py').read_text(encoding='utf-8') == 'value = 1\n'
    assert not (snapshot_root / 'ignored_dir').exists()


def test_stage_workspace_file_overwrite_uses_active_snapshot_baseline(staging_env) -> None:
    ws = staging_env.workspace
    session = staging_env.session
    target = ws / 'baseline.py'
    target.write_text('value = 1\n', encoding='utf-8')
    begin_staging_snapshot_session(session, 'test-staging-session', ws)
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


def test_format_staging_file_prettier_updates_draft(monkeypatch, staging_env) -> None:
    session = staging_env.session

    from clara_coder_backend.staging import edit_staging as _es
    class _FakeLspMgr:
        def sync_workspace_document(self, relative_path: str, *, encoding: str = 'utf-8') -> list:
            return []

    monkeypatch.setattr(
        'clara_coder_backend.tools.staging_edit.get_session_lsp_manager',
        lambda *args, **kwargs: _FakeLspMgr(),
    )

    def _fake_fmt(text: str, **kwargs: object) -> tuple[str | None, str]:
        del kwargs
        return 'const x = 1;\n', ''

    monkeypatch.setattr(_es, 'format_source_via_prettier', _fake_fmt)

    stage_create_file.invoke(
        {
            'relative_path': 'a.ts',
            'new_content': 'const x=1\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    assert session.pending_edit_stagings['a.ts'].merged_text == 'const x = 1;\n'

    out = format_staging_file_prettier.invoke({'relative_path': 'a.ts'})
    assert 'Prettier' in out
    assert session.pending_edit_stagings['a.ts'].merged_text == 'const x = 1;\n'


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
        'clara_coder_backend.tools.review_tools.run_grep_line_search',
        _fake_run_grep_line_search,
    )

    hits = search_staged_edits.invoke({'query': 'BETA', 'relative_path': 'multi.py'})

    assert seen == [('multi.py',)]
    assert '[multi.py line 2] │ BETA' in hits


def test_transfer_sets_diff_payload(staging_env) -> None:
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
    out = transfer_staged_file_to_workspace.invoke({'relative_path': 'q.py'})
    assert 'human confirmation' in out.lower()
    assert (ws / 'q.py').read_text(encoding='utf-8') == 'n=0\n'
    assert session.pending_staged_transfer_hitl is not None
    assert session.pending_staged_transfer_hitl.relative_paths == ['q.py']
    assert session.pending_staged_transfer_batch_payload is not None
    assert session.pending_staged_transfer_batch_payload['files'][0].get('stagedTransferHitl') is True
    assert session.pending_diff_payload is None
    assert 'q.py' in session.pending_edit_stagings
    assert session.pending_edit_stagings['q.py'].workspace_applied is False

    msg = finalize_staged_transfer_after_hitl(session, 'confirm', '')
    assert 'User approved staged transfer' in msg
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
    assert session.pending_staged_transfer_batch_payload is not None
    assert 'transfer.py' in session.pending_edit_stagings
    assert session.pending_edit_stagings['transfer.py'].workspace_applied is False

    finalize_staged_transfer_after_hitl(session, 'confirm', '')
    assert (ws / 'transfer.py').read_text(encoding='utf-8') == 'x = 1\n'
    assert session.pending_edit_stagings['transfer.py'].workspace_applied is True


def test_stage_create_file_land_in_workspace_sets_hitl(staging_env) -> None:
    """Same as staging then transfer when auto_apply is off, in one call."""
    ws = staging_env.workspace
    session = staging_env.session
    (ws / 'land1.py').write_text('a=0\n', encoding='utf-8')
    out = stage_create_file.invoke(
        {
            'relative_path': 'land1.py',
            'new_content': 'a = 0\n',
            'encoding': 'utf-8',
            'newline': 'lf',
            'land_in_workspace': True,
        }
    )
    assert '---' in out
    assert 'human confirmation' in out.lower()
    assert (ws / 'land1.py').read_text(encoding='utf-8') == 'a=0\n'
    assert session.pending_staged_transfer_hitl is not None
    assert session.pending_staged_transfer_hitl.relative_paths == ['land1.py']
    assert session.pending_staged_transfer_batch_payload is not None
    assert session.pending_staged_transfer_batch_payload['files'][0].get('stagedTransferHitl') is True
    assert 'land1.py' in session.pending_edit_stagings
    assert session.pending_edit_stagings['land1.py'].workspace_applied is False


def test_stage_create_file_land_in_workspace_auto_apply_writes(staging_env) -> None:
    ws = staging_env.workspace
    session = staging_env.session
    session.auto_apply_mode = True
    (ws / 'land2.py').write_text('z=0\n', encoding='utf-8')
    out = stage_create_file.invoke(
        {
            'relative_path': 'land2.py',
            'new_content': 'z = 0\n',
            'encoding': 'utf-8',
            'newline': 'lf',
            'land_in_workspace': True,
        }
    )
    assert 'real workspace' in out.lower()
    assert (ws / 'land2.py').read_text(encoding='utf-8') == 'z = 0\n'
    assert session.pending_staged_transfer_hitl is None
    assert session.pending_edit_stagings['land2.py'].workspace_applied is True


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


def test_transfer_defers_workspace_lsp_until_all_paths_transferred(staging_env, monkeypatch) -> None:
    """LSP sync runs once after the last transfer when multiple paths are pending in one chain."""
    ws = staging_env.workspace
    session = staging_env.session
    session.auto_apply_mode = True
    calls: list[str] = []

    def _fake_sync(rel: str, text: str, *, session_id=None, scope=None):
        del text, session_id, scope
        calls.append(rel)
        return []

    monkeypatch.setattr(
        'clara_coder_backend.tools.review_tools.sync_session_document',
        _fake_sync,
    )

    (ws / 'first.py').write_text('x=0\n', encoding='utf-8')
    (ws / 'second.py').write_text('y=0\n', encoding='utf-8')
    stage_workspace_file_overwrite.invoke(
        {
            'relative_path': 'first.py',
            'new_content': 'x = 0\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    stage_workspace_file_overwrite.invoke(
        {
            'relative_path': 'second.py',
            'new_content': 'y = 0\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )

    out1 = transfer_staged_file_to_workspace.invoke({'relative_path': 'first.py'})
    assert calls == []
    assert 'deferred' in out1.lower()

    out2 = transfer_staged_file_to_workspace.invoke({'relative_path': 'second.py'})
    assert set(calls) == {'first.py', 'second.py'}
    assert len(calls) == 2
    assert 'Post-transfer LSP' in out2


def test_batch_transfer_hitl_builds_batch_payload(staging_env) -> None:
    ws = staging_env.workspace
    session = staging_env.session
    session.auto_apply_mode = False
    for name, content in (('a.py', 'a=0\n'), ('b.py', 'b=0\n')):
        (ws / name).write_text(content, encoding='utf-8')
        stage_create_file.invoke(
            {
                'relative_path': name,
                'new_content': content.replace('=', ' = '),
                'encoding': 'utf-8',
                'newline': 'lf',
            }
        )
    out = transfer_staged_file_to_workspace.invoke({'relative_paths': ['a.py', 'b.py']})
    assert 'human confirmation' in out.lower()
    assert session.pending_staged_transfer_hitl is not None
    assert session.pending_staged_transfer_hitl.relative_paths == ['a.py', 'b.py']
    batch = session.pending_staged_transfer_batch_payload
    assert batch is not None
    assert batch['requestId'] == session.pending_staged_transfer_hitl.request_id
    assert len(batch['files']) == 2


def test_batch_transfer_partial_confirm_then_complete(staging_env) -> None:
    ws = staging_env.workspace
    session = staging_env.session
    session.auto_apply_mode = False
    for name, content in (('one.py', 'one=0\n'), ('two.py', 'two=0\n')):
        (ws / name).write_text(content, encoding='utf-8')
        stage_create_file.invoke(
            {
                'relative_path': name,
                'new_content': content.replace('=', ' = '),
                'encoding': 'utf-8',
                'newline': 'lf',
            }
        )
    transfer_staged_file_to_workspace.invoke({'relative_paths': ['one.py', 'two.py']})
    pending = session.pending_staged_transfer_hitl
    assert pending is not None
    complete, msg = resolve_staged_transfer_batch_file(
        session,
        request_id=pending.request_id,
        relative_path='one.py',
        action='confirm',
        user_note='',
    )
    assert complete is False
    assert msg == ''
    assert (ws / 'one.py').read_text(encoding='utf-8') == 'one = 0\n'
    assert session.pending_staged_transfer_hitl is not None
    assert session.pending_edit_stagings['one.py'].workspace_applied is True
    assert session.pending_edit_stagings['two.py'].workspace_applied is False

    complete, msg = resolve_staged_transfer_batch_file(
        session,
        request_id=pending.request_id,
        relative_path='two.py',
        action='re_review',
        user_note='fix naming',
    )
    assert complete is True
    assert 're-review' in msg.lower()
    assert (ws / 'two.py').read_text(encoding='utf-8') == 'two=0\n'
    assert session.pending_staged_transfer_hitl is None


def test_batch_transfer_auto_apply_writes_all(staging_env) -> None:
    ws = staging_env.workspace
    session = staging_env.session
    session.auto_apply_mode = True
    for name, content in (('x.py', 'x=0\n'), ('y.py', 'y=0\n')):
        (ws / name).write_text(content, encoding='utf-8')
        stage_create_file.invoke(
            {
                'relative_path': name,
                'new_content': content.replace('=', ' = '),
                'encoding': 'utf-8',
                'newline': 'lf',
            }
        )
    out = transfer_staged_file_to_workspace.invoke({'relative_paths': ['x.py', 'y.py']})
    assert 'Transferred 2 staged path(s)' in out
    assert (ws / 'x.py').read_text(encoding='utf-8') == 'x = 0\n'
    assert (ws / 'y.py').read_text(encoding='utf-8') == 'y = 0\n'


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
    (ws / 'python' / 'clara_coder_backend').mkdir(parents=True)
    target = ws / 'python' / 'clara_coder_backend' / 'main.py'
    target.write_text('VALUE = 1\n', encoding='utf-8')
    stage_workspace_file_overwrite.invoke(
        {
            'relative_path': 'python/clara_coder_backend/main.py',
            'new_content': 'VALUE = 2\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    assert session.pending_edit_stagings['python/clara_coder_backend/main.py'].merged_text == 'VALUE = 2\n'

    ok, detail = _materialize_staged_python_files(
        session,
        [('python/clara_coder_backend/main.py', session.pending_edit_stagings['python/clara_coder_backend/main.py'])],
    )
    assert ok is True
    assert detail == ''
    assert target.read_text(encoding='utf-8') == 'VALUE = 2\n'

    out = reject_staged_workspace_edit.invoke(
        {'relative_path': 'python/clara_coder_backend/main.py', 'feedback': 'fix failing test'}
    )
    assert 'Rejected staged edit' in out
    assert target.read_text(encoding='utf-8') == 'VALUE = 1\n'
