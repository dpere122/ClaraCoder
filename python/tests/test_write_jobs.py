"""Managed staging write jobs: start / wait / cancel / coalesce / timeout / land."""

from __future__ import annotations

import asyncio
import threading
import time

import pytest

from clara_coder_backend.session.lifecycle import teardown_session
from clara_coder_backend.tools.staging_edit import (
    execute_staging_write_job,
    stage_create_file,
    stage_workspace_file_overwrite,
)
from clara_coder_backend.tools.write_jobs import (
    PHASE_FORMATTING,
    STATUS_RUNNING,
    cancel_write,
    list_write_jobs,
    wait_for_write,
    write_jobs,
)


@pytest.fixture()
def _clean_write_jobs():
    yield
    for job in list(write_jobs().values()):
        from clara_coder_backend.tools.write_jobs import cancel_write_job

        cancel_write_job(job)


def _hold_then_run(gate: threading.Event):
    """Wrap the real runner so tests can observe a still-running job."""

    def runner(job):
        job.phase = PHASE_FORMATTING
        if not gate.wait(timeout=5):
            raise RuntimeError('write-job test gate timed out')
        return execute_staging_write_job(job)

    return runner


def _wait_for_write(write_id: str, wait_seconds: float) -> str:
    return asyncio.run(wait_for_write.ainvoke({'write_id': write_id, 'wait_seconds': wait_seconds}))


def test_write_job_finishes_inside_wait_window(staging_env, _clean_write_jobs) -> None:
    out = stage_create_file.invoke(
        {
            'relative_path': 'quick.py',
            'new_content': 'x = 1\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    assert 'for review' in out.lower()
    assert 'quick.py' in staging_env.session.pending_edit_stagings
    assert not any(j.session_id == staging_env.session_id for j in write_jobs().values())


def test_slow_write_returns_job_id_then_wait_collects_result(
    staging_env, monkeypatch, _clean_write_jobs
) -> None:
    gate = threading.Event()
    monkeypatch.setattr('clara_coder_backend.tools.staging_edit.execute_staging_write_job', _hold_then_run(gate))
    monkeypatch.setattr('clara_coder_backend.tools.staging_edit.CLARA_WRITE_JOB_DEFAULT_WAIT_SEC', 0.05)

    out = stage_create_file.invoke(
        {
            'relative_path': 'slow.py',
            'new_content': 'y = 2\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    assert 'still running' in out.lower()
    assert 'write id:' in out.lower()
    assert 'slow.py' not in staging_env.session.pending_edit_stagings
    running = [j for j in write_jobs().values() if j.session_id == staging_env.session_id]
    assert len(running) == 1
    job_id = running[0].job_id
    assert job_id in out

    gate.set()
    waited = _wait_for_write(job_id, 3)
    assert 'for review' in waited.lower()
    assert 'slow.py' in staging_env.session.pending_edit_stagings
    assert job_id not in write_jobs()


def test_second_stage_on_same_path_coalesces(staging_env, monkeypatch, _clean_write_jobs) -> None:
    gate = threading.Event()
    monkeypatch.setattr('clara_coder_backend.tools.staging_edit.execute_staging_write_job', _hold_then_run(gate))
    monkeypatch.setattr('clara_coder_backend.tools.staging_edit.CLARA_WRITE_JOB_DEFAULT_WAIT_SEC', 0.05)

    first = stage_create_file.invoke(
        {
            'relative_path': 'once.py',
            'new_content': 'a = 1\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    running = [j for j in write_jobs().values() if j.session_id == staging_env.session_id]
    assert len(running) == 1
    job_id = running[0].job_id
    temps_before = {j.temp_path for j in running}

    second = stage_create_file.invoke(
        {
            'relative_path': 'once.py',
            'new_content': 'a = 99\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    still = [j for j in write_jobs().values() if j.session_id == staging_env.session_id]
    assert len(still) == 1
    assert still[0].job_id == job_id
    assert {j.temp_path for j in still} == temps_before
    assert 'already running' in second.lower()
    assert job_id in first and job_id in second

    gate.set()
    _wait_for_write(job_id, 3)


def test_cancel_write_keeps_prior_draft(staging_env, monkeypatch, _clean_write_jobs) -> None:
    first = stage_create_file.invoke(
        {
            'relative_path': 'keep.py',
            'new_content': 'old = 1\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    assert 'for review' in first.lower()
    prior = staging_env.session.pending_edit_stagings['keep.py']
    prior_temp = prior.temp_path
    prior_text = prior.merged_text

    gate = threading.Event()
    monkeypatch.setattr('clara_coder_backend.tools.staging_edit.execute_staging_write_job', _hold_then_run(gate))
    monkeypatch.setattr('clara_coder_backend.tools.staging_edit.CLARA_WRITE_JOB_DEFAULT_WAIT_SEC', 0.05)

    stage_create_file.invoke(
        {
            'relative_path': 'keep.py',
            'new_content': 'new = 2\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    running = [j for j in write_jobs().values() if j.session_id == staging_env.session_id]
    assert len(running) == 1
    job_id = running[0].job_id

    cancelled = cancel_write.invoke({'write_id': job_id})
    assert 'cancelled' in cancelled.lower()
    gate.set()
    time.sleep(0.05)

    entry = staging_env.session.pending_edit_stagings['keep.py']
    assert entry.temp_path == prior_temp
    assert entry.merged_text == prior_text


def test_hard_timeout_fails_without_commit(staging_env, monkeypatch, _clean_write_jobs) -> None:
    started = threading.Event()

    def hang(job):
        job.phase = PHASE_FORMATTING
        started.set()
        time.sleep(2)
        return execute_staging_write_job(job)

    monkeypatch.setattr('clara_coder_backend.tools.write_jobs.CLARA_WRITE_JOB_TIMEOUT_SEC', 0.15)
    monkeypatch.setattr('clara_coder_backend.tools.staging_edit.execute_staging_write_job', hang)
    monkeypatch.setattr('clara_coder_backend.tools.staging_edit.CLARA_WRITE_JOB_DEFAULT_WAIT_SEC', 1.0)

    out = stage_create_file.invoke(
        {
            'relative_path': 'hang.py',
            'new_content': 'z = 0\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    assert started.wait(timeout=1)
    assert 'timed out' in out.lower() or 'failed' in out.lower()
    assert 'hang.py' not in staging_env.session.pending_edit_stagings


def test_land_runs_on_wait_for_write_after_job_done(
    staging_env, monkeypatch, _clean_write_jobs
) -> None:
    gate = threading.Event()
    monkeypatch.setattr('clara_coder_backend.tools.staging_edit.execute_staging_write_job', _hold_then_run(gate))
    monkeypatch.setattr('clara_coder_backend.tools.staging_edit.CLARA_WRITE_JOB_DEFAULT_WAIT_SEC', 0.05)

    out = stage_create_file.invoke(
        {
            'relative_path': 'land-later.py',
            'new_content': 'q = 1\n',
            'encoding': 'utf-8',
            'newline': 'lf',
            'land_in_workspace': True,
        }
    )
    assert 'still running' in out.lower()
    assert staging_env.session.pending_staged_transfer_hitl is None
    job_id = next(j.job_id for j in write_jobs().values() if j.session_id == staging_env.session_id)

    gate.set()
    waited = _wait_for_write(job_id, 3)
    assert 'human confirmation' in waited.lower()
    assert staging_env.session.pending_staged_transfer_hitl is not None
    assert staging_env.session.pending_staged_transfer_hitl.relative_paths == ['land-later.py']
    assert staging_env.session.pending_edit_stagings['land-later.py'].workspace_applied is False


@pytest.mark.asyncio(loop_scope='function')
async def test_session_teardown_cancels_write_jobs(staging_env, monkeypatch, _clean_write_jobs) -> None:
    gate = threading.Event()
    monkeypatch.setattr('clara_coder_backend.tools.staging_edit.execute_staging_write_job', _hold_then_run(gate))
    monkeypatch.setattr('clara_coder_backend.tools.staging_edit.CLARA_WRITE_JOB_DEFAULT_WAIT_SEC', 0.05)

    stage_create_file.invoke(
        {
            'relative_path': 'teardown.py',
            'new_content': 't = 1\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    assert any(j.session_id == staging_env.session_id and j.status == STATUS_RUNNING for j in write_jobs().values())

    await teardown_session(staging_env.session_id)
    assert not any(j.session_id == staging_env.session_id for j in write_jobs().values())
    gate.set()


def test_list_write_jobs_shows_running(staging_env, monkeypatch, _clean_write_jobs) -> None:
    gate = threading.Event()
    monkeypatch.setattr('clara_coder_backend.tools.staging_edit.execute_staging_write_job', _hold_then_run(gate))
    monkeypatch.setattr('clara_coder_backend.tools.staging_edit.CLARA_WRITE_JOB_DEFAULT_WAIT_SEC', 0.05)

    stage_create_file.invoke(
        {
            'relative_path': 'listed.py',
            'new_content': 'l = 1\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    listing = list_write_jobs.invoke({})
    assert 'listed.py' in listing
    assert 'running' in listing.lower()
    gate.set()
    running = [j for j in write_jobs().values() if j.session_id == staging_env.session_id]
    if running:
        _wait_for_write(running[0].job_id, 3)


def test_overwrite_missing_path_does_not_start_a_job(staging_env, _clean_write_jobs) -> None:
    out = stage_workspace_file_overwrite.invoke(
        {
            'relative_path': 'missing-should-fail.py',
            'new_content': 'nope\n',
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )
    assert 'does not exist' in out.lower()
    assert not any(j.rel_display.endswith('missing-should-fail.py') for j in write_jobs().values())
