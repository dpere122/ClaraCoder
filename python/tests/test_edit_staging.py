"""Nested edit staging, Black, code review tools, and cleanup."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest

from nemo_backend.agents.specialists.review_tools import (
    approve_staged_workspace_edit,
    format_staging_file_black,
    read_staged_edit,
    reject_staged_workspace_edit,
)
from nemo_backend.domain import EditStagingEntry, RuntimeToolsConfig
from nemo_backend.edit_staging import (
    discard_all_session_stagings,
    get_staging_root,
    is_code_review_extension,
)
from nemo_backend.edit_tool import apply_workspace_full_file
from nemo_backend.state import current_session_id, get_session, nested_edit_staging_active, runtime_config


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
    assert not is_code_review_extension('README.md')


def test_stages_python_file_when_nested_active(staging_env) -> None:
    ws = staging_env.workspace
    session = staging_env.session
    (ws / 'mod.py').write_text('x=1\n', encoding='utf-8')
    t = nested_edit_staging_active.set(True)
    try:
        out = apply_workspace_full_file.invoke(
            {
                'relative_path': 'mod.py',
                'new_content': 'x = 1\n',
                'encoding': 'utf-8',
                'newline': 'lf',
            }
        )
    finally:
        nested_edit_staging_active.reset(t)
    assert 'code review' in out.lower()
    assert 'mod.py' in session.pending_edit_stagings
    entry = session.pending_edit_stagings['mod.py']
    assert Path(entry.temp_path).is_file()


def test_non_code_finalizes_without_staging_dict(staging_env) -> None:
    ws = staging_env.workspace
    session = staging_env.session
    (ws / 'note.txt').write_text('hi\n', encoding='utf-8')
    t = nested_edit_staging_active.set(True)
    try:
        out = apply_workspace_full_file.invoke(
            {
                'relative_path': 'note.txt',
                'new_content': 'hello\n',
                'encoding': 'utf-8',
                'newline': 'lf',
            }
        )
    finally:
        nested_edit_staging_active.reset(t)
    assert session.pending_edit_stagings == {}
    assert 'Proposed' in out
    assert session.pending_diff_payload is not None


def test_nested_inactive_goes_straight_to_diff(staging_env) -> None:
    ws = staging_env.workspace
    session = staging_env.session
    (ws / 'a.py').write_text('y=2\n', encoding='utf-8')
    out = apply_workspace_full_file.invoke(
        {
            'relative_path': 'a.py',
            'new_content': 'y = 2\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    assert session.pending_edit_stagings == {}
    assert 'Proposed' in out


def test_read_format_approve_reject(staging_env) -> None:
    ws = staging_env.workspace
    session = staging_env.session
    (ws / 'z.py').write_text('a=1\n', encoding='utf-8')
    t = nested_edit_staging_active.set(True)
    try:
        apply_workspace_full_file.invoke(
            {
                'relative_path': 'z.py',
                'new_content': 'a=1\nb=2\n',
                'encoding': 'utf-8',
                'newline': 'lf',
            }
        )
    finally:
        nested_edit_staging_active.reset(t)
    r1 = read_staged_edit.invoke({'relative_path': 'z.py'})
    assert 'z.py' in r1
    assert 'b = 2' in r1
    fmt = format_staging_file_black.invoke({'relative_path': 'z.py'})
    assert 'Black' in fmt
    rej = reject_staged_workspace_edit.invoke({'relative_path': 'z.py', 'feedback': 'no'})
    assert 'Rejected' in rej
    assert session.pending_edit_stagings == {}


def test_approve_sets_diff_payload(staging_env) -> None:
    ws = staging_env.workspace
    session = staging_env.session
    (ws / 'q.py').write_text('n=0\n', encoding='utf-8')
    t = nested_edit_staging_active.set(True)
    try:
        apply_workspace_full_file.invoke(
            {
                'relative_path': 'q.py',
                'new_content': 'n = 0\n',
                'encoding': 'utf-8',
                'newline': 'lf',
            }
        )
    finally:
        nested_edit_staging_active.reset(t)
    session.auto_apply_mode = False
    out = approve_staged_workspace_edit.invoke({'relative_path': 'q.py'})
    assert 'diff' in out.lower()
    assert session.pending_diff_payload is not None
    assert session.pending_edit_stagings == {}


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
