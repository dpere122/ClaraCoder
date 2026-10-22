"""Unit tests for the outer-agent workspace copy tool."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from clara_coder_backend.tools.copy import copy_workspace_files
from clara_coder_backend.session.state import current_session_id, get_session


@pytest.fixture()
def copy_env():
    td = tempfile.TemporaryDirectory()
    workspace = Path(td.name) / 'ws'
    workspace.mkdir()

    session_id = 'test-copy-session'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.workspace_path = str(workspace.resolve())
    session.worker_apply_mode = True
    session.auto_apply_mode = False

    class _Env:
        pass

    env = _Env()
    env.workspace = workspace  # type: ignore[attr-defined]
    env.session = session  # type: ignore[attr-defined]

    yield env

    current_session_id.reset(token)
    td.cleanup()


def test_copy_workspace_files_creates_subdirectories(copy_env) -> None:
    ws = copy_env.workspace
    (ws / 'src').mkdir()
    (ws / 'src' / 'one.txt').write_text('one', encoding='utf-8')
    (ws / 'src' / 'two.txt').write_text('two', encoding='utf-8')

    out = copy_workspace_files.invoke(
        {
            'copies': [
                {'source_path': 'src/one.txt', 'destination_path': 'dist/nested/one.txt'},
                {'source_path': 'src/two.txt', 'destination_path': 'dist/two-copy.txt'},
            ]
        }
    )

    assert 'Copied 2 file(s)' in out
    assert (ws / 'dist' / 'nested' / 'one.txt').read_text(encoding='utf-8') == 'one'
    assert (ws / 'dist' / 'two-copy.txt').read_text(encoding='utf-8') == 'two'


def test_copy_runs_immediately_with_auto_run_off(copy_env) -> None:
    ws = copy_env.workspace
    copy_env.session.auto_apply_mode = False
    (ws / 'src.txt').write_text('copy me', encoding='utf-8')

    out = copy_workspace_files.invoke(
        {'copies': [{'source_path': 'src.txt', 'destination_path': 'copies/subdir/dst.txt'}]}
    )

    assert 'Copied 1 file(s)' in out
    assert (ws / 'copies' / 'subdir' / 'dst.txt').read_text(encoding='utf-8') == 'copy me'


def test_copy_refuses_existing_destination_without_overwrite(copy_env) -> None:
    ws = copy_env.workspace
    (ws / 'a.txt').write_text('a', encoding='utf-8')
    (ws / 'b.txt').write_text('b', encoding='utf-8')

    out = copy_workspace_files.invoke({'copies': [{'source_path': 'a.txt', 'destination_path': 'b.txt'}]})
    assert out.startswith('Tool error:')
    assert (ws / 'b.txt').read_text(encoding='utf-8') == 'b'

    out = copy_workspace_files.invoke(
        {'copies': [{'source_path': 'a.txt', 'destination_path': 'b.txt'}], 'overwrite': True}
    )
    assert 'Copied 1 file(s)' in out
    assert (ws / 'b.txt').read_text(encoding='utf-8') == 'a'


def test_copy_workspace_files_rejects_duplicate_destinations(copy_env) -> None:
    ws = copy_env.workspace
    (ws / 'one.txt').write_text('one', encoding='utf-8')
    (ws / 'two.txt').write_text('two', encoding='utf-8')

    out = copy_workspace_files.invoke(
        {
            'copies': [
                {'source_path': 'one.txt', 'destination_path': 'dup.txt'},
                {'source_path': 'two.txt', 'destination_path': 'dup.txt'},
            ]
        }
    )

    assert 'duplicate destination path' in out


def test_copy_reports_items_copied_before_a_destination_appears(copy_env, monkeypatch) -> None:
    """A parallel call creating a later destination mid-copy stops the batch; the earlier copy is reported."""
    import clara_coder_backend.tools.copy as copy_mod

    ws = copy_env.workspace
    (ws / 'one.txt').write_text('one', encoding='utf-8')
    (ws / 'two.txt').write_text('two', encoding='utf-8')
    real_copy2 = copy_mod.shutil.copy2

    def copy_then_race(src, dest):
        real_copy2(src, dest)
        (ws / 'two-copy.txt').write_text('raced', encoding='utf-8')

    monkeypatch.setattr(copy_mod.shutil, 'copy2', copy_then_race)
    out = copy_workspace_files.invoke(
        {
            'copies': [
                {'source_path': 'one.txt', 'destination_path': 'one-copy.txt'},
                {'source_path': 'two.txt', 'destination_path': 'two-copy.txt'},
            ]
        }
    )

    assert 'Destination already exists: `two-copy.txt`' in out
    assert 'Copied 1 file(s) before stopping: `one.txt` -> `one-copy.txt`' in out
    assert (ws / 'two-copy.txt').read_text(encoding='utf-8') == 'raced'
