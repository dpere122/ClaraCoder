"""Background command framework: run_command / wait_for_command / kill_background_command."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from clara_coder_backend.hitl.accept_command import ACCEPT_COMMAND_KIND_DEFERRED_TOOL
from clara_coder_backend.hitl.deferred_tool_hitl import DEFERRED_HITL_TOOL_NAMES
from clara_coder_backend.session.state import current_session_id, get_session
from clara_coder_backend.hitl.tool_registry import hitl_accept_command_pause_tools
from clara_coder_backend.tools.run_command import (
    RUN_COMMAND_NAME,
    STATUS_RUNNING,
    background_command_jobs,
    kill_background_command_tool,
    kill_session_background_commands,
    list_background_commands_tool,
    normalize_run_command_elevation,
    run_command_tool,
    validate_run_command_text,
    wait_for_command_tool,
)


@pytest.fixture()
def command_session():
    """Session with a real temp workspace, Editor on, auto-apply on (no HITL pause)."""
    session_id = 'run-command-test-session'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    with tempfile.TemporaryDirectory() as td:
        session.workspace_path = str(Path(td).resolve())
        session.worker_apply_mode = True
        session.auto_apply_mode = True
        session.pending_accept_command_request = None
        try:
            yield session
        finally:
            current_session_id.reset(token)


async def _cleanup(session_id: str) -> None:
    await kill_session_background_commands(session_id)


def test_run_command_in_accept_command_pause_registry() -> None:
    assert RUN_COMMAND_NAME in DEFERRED_HITL_TOOL_NAMES
    assert RUN_COMMAND_NAME in hitl_accept_command_pause_tools()


@pytest.mark.asyncio(loop_scope='function')
async def test_run_command_completes_within_wait(command_session) -> None:
    try:
        out = await run_command_tool.ainvoke({'command': 'echo hello-clara', 'wait_seconds': 15})
        assert 'exited with code 0' in out
        assert 'hello-clara' in out
        assert not [j for j in background_command_jobs().values() if j.session_id == 'run-command-test-session']
    finally:
        await _cleanup('run-command-test-session')


@pytest.mark.asyncio(loop_scope='function')
async def test_run_command_reports_nonzero_exit(command_session) -> None:
    try:
        out = await run_command_tool.ainvoke({'command': 'exit 3', 'wait_seconds': 15})
        assert 'exited with code 3' in out
    finally:
        await _cleanup('run-command-test-session')


@pytest.mark.asyncio(loop_scope='function')
async def test_long_command_backgrounds_then_waits_then_kills(command_session) -> None:
    try:
        out = await run_command_tool.ainvoke(
            {'command': 'echo started; sleep 60', 'wait_seconds': 1}
        )
        assert 'still running' in out
        assert 'started' in out
        jobs = [j for j in background_command_jobs().values() if j.session_id == 'run-command-test-session']
        assert len(jobs) == 1
        job = jobs[0]
        assert job.status == STATUS_RUNNING
        assert f'`{job.job_id}`' in out

        # Status check without extra wait: no new output since the first report.
        waited = await wait_for_command_tool.ainvoke({'command_id': job.job_id, 'wait_seconds': 0})
        assert 'still running' in waited
        assert 'New output: (none)' in waited

        killed = await kill_background_command_tool.ainvoke({'command_id': job.job_id})
        assert 'killed' in killed
        assert job.job_id not in background_command_jobs()
    finally:
        await _cleanup('run-command-test-session')


@pytest.mark.asyncio(loop_scope='function')
async def test_wait_for_command_collects_incremental_output(command_session) -> None:
    try:
        await run_command_tool.ainvoke(
            {'command': 'echo first; sleep 2; echo second; sleep 60', 'wait_seconds': 1}
        )
        jobs = [j for j in background_command_jobs().values() if j.session_id == 'run-command-test-session']
        job = jobs[0]
        waited = await wait_for_command_tool.ainvoke({'command_id': job.job_id, 'wait_seconds': 3})
        assert 'second' in waited
        assert 'first' not in waited.split('New output:')[1]
    finally:
        await _cleanup('run-command-test-session')


@pytest.mark.asyncio(loop_scope='function')
async def test_run_command_stages_hitl_when_auto_apply_off(command_session) -> None:
    command_session.auto_apply_mode = False
    try:
        out = await run_command_tool.ainvoke({'command': 'echo hi', 'wait_seconds': 5})
        assert 'Pending user confirmation' in out
        pending = command_session.pending_accept_command_request
        assert pending is not None
        assert pending['kind'] == ACCEPT_COMMAND_KIND_DEFERRED_TOOL
        assert pending['action']['tool_name'] == RUN_COMMAND_NAME
        assert pending['action']['tool_input']['command'] == 'echo hi'
        assert pending['command_text'] == 'echo hi'
        # Nothing spawned yet.
        assert not [j for j in background_command_jobs().values() if j.session_id == 'run-command-test-session']
    finally:
        command_session.pending_accept_command_request = None
        await _cleanup('run-command-test-session')


@pytest.mark.asyncio(loop_scope='function')
async def test_run_command_blocked_when_editor_off(command_session) -> None:
    command_session.worker_apply_mode = False
    out = await run_command_tool.ainvoke({'command': 'echo hi'})
    assert 'Editor mode is off' in out


@pytest.mark.asyncio(loop_scope='function')
async def test_run_command_rejects_escaping_cwd(command_session) -> None:
    out = await run_command_tool.ainvoke({'command': 'echo hi', 'cwd': '../../etc', 'wait_seconds': 1})
    assert 'Tool error' in out


@pytest.mark.asyncio(loop_scope='function')
async def test_wait_for_unknown_command_id_lists_running(command_session) -> None:
    out = await wait_for_command_tool.ainvoke({'command_id': 'nope1234'})
    assert 'no background command with id' in out
    assert 'No background commands are running' in out


@pytest.mark.asyncio(loop_scope='function')
async def test_list_background_commands_and_session_cleanup(command_session) -> None:
    try:
        await run_command_tool.ainvoke({'command': 'sleep 60', 'wait_seconds': 0})
        listing = await list_background_commands_tool.ainvoke({})
        assert 'Background commands:' in listing
        assert 'sleep 60' in listing

        await kill_session_background_commands('run-command-test-session')
        assert not [j for j in background_command_jobs().values() if j.session_id == 'run-command-test-session']
        listing_after = await list_background_commands_tool.ainvoke({})
        assert listing_after == 'No background commands in this session.'
    finally:
        await _cleanup('run-command-test-session')


@pytest.mark.parametrize(
    ('raw', 'elevate_in', 'expected_command', 'expected_elevate'),
    [
        ('echo hi', False, 'echo hi', False),
        ('echo hi', True, 'echo hi', True),
        ('sudo apt install foo', False, 'apt install foo', True),
        ('sudo -- apt install foo', False, 'apt install foo', True),
        ('sudo -n apt install foo', False, 'apt install foo', True),
        ('sudo -E -- id', True, 'id', True),
    ],
)
def test_normalize_run_command_elevation(
    raw: str,
    elevate_in: bool,
    expected_command: str,
    expected_elevate: bool,
) -> None:
    command, elevate = normalize_run_command_elevation(raw, elevate_in)
    assert command == expected_command
    assert elevate is expected_elevate


@pytest.mark.asyncio(loop_scope='function')
async def test_elevate_still_denied_by_denylist(command_session) -> None:
    command_session.auto_apply_mode = True
    command_session.admin_elevation_granted = True
    out = await run_command_tool.ainvoke({'command': 'rm -rf /', 'elevate': True, 'wait_seconds': 1})
    assert 'blocked by safety policy' in out
    assert not [j for j in background_command_jobs().values() if j.session_id == 'run-command-test-session']
    assert validate_run_command_text('rm -rf /') is not None


@pytest.mark.asyncio(loop_scope='function')
async def test_sudo_without_admin_grant_stages_admin_hitl(command_session) -> None:
    command_session.auto_apply_mode = True
    command_session.admin_elevation_granted = False
    try:
        out = await run_command_tool.ainvoke({'command': 'sudo echo elevated-hi', 'wait_seconds': 5})
        assert 'Pending user confirmation for administrator access' in out
        pending = command_session.pending_accept_command_request
        assert pending is not None
        assert pending['kind'] == 'admin_elevation_tool'
        assert pending['confirm_label'] == 'Allow'
        assert pending['command_text'] == ''
        assert pending['action']['tool_input']['elevate'] is True
        assert pending['action']['tool_input']['command'] == 'echo elevated-hi'
        assert not [j for j in background_command_jobs().values() if j.session_id == 'run-command-test-session']
    finally:
        command_session.pending_accept_command_request = None


@pytest.mark.asyncio(loop_scope='function')
async def test_granted_session_skips_elevate_hitl_and_runs(command_session, monkeypatch: pytest.MonkeyPatch) -> None:
    command_session.auto_apply_mode = True
    command_session.admin_elevation_granted = True
    monkeypatch.setattr(
        'clara_coder_backend.tools.run_command.is_currently_privileged',
        lambda: True,
    )
    try:
        out = await run_command_tool.ainvoke(
            {'command': 'echo elevated-granted', 'elevate': True, 'wait_seconds': 15}
        )
        assert 'exited with code 0' in out
        assert 'elevated-granted' in out
        assert 'Elevation:' in out
        assert command_session.pending_accept_command_request is None
    finally:
        await _cleanup('run-command-test-session')


@pytest.mark.asyncio(loop_scope='function')
async def test_granted_session_still_hitl_when_auto_apply_off(command_session) -> None:
    command_session.auto_apply_mode = False
    command_session.admin_elevation_granted = True
    try:
        out = await run_command_tool.ainvoke(
            {'command': 'echo still-ask', 'elevate': True, 'wait_seconds': 5}
        )
        assert 'Pending user confirmation' in out
        pending = command_session.pending_accept_command_request
        assert pending is not None
        assert pending['confirm_label'] == 'Run'
        assert 'confirm_session_label' not in pending
        assert not [j for j in background_command_jobs().values() if j.session_id == 'run-command-test-session']
    finally:
        command_session.pending_accept_command_request = None
        await _cleanup('run-command-test-session')
