from __future__ import annotations

import asyncio

import pytest

from nemo_backend.subprocess_smoke import (
    SmokeOutputTracker,
    SmokeStopReason,
    argv_implies_watch_mode,
    wait_for_smoke_completion,
)


def test_argv_implies_watch_mode_detects_vite_and_electronmon() -> None:
    assert argv_implies_watch_mode(['npx', 'vite'])
    assert argv_implies_watch_mode(['npm', 'run', 'dev'])
    assert argv_implies_watch_mode(['electronmon', 'dist/main/index.js'])
    assert argv_implies_watch_mode(['tsc', '-p', './', '--watch'])
    assert argv_implies_watch_mode(['ng', 'serve'])
    assert not argv_implies_watch_mode(['npm', 'run', 'build'])
    assert not argv_implies_watch_mode(['tsc', '-p', './', '--watch=false'])


def test_smoke_output_tracker_detects_vite_readiness_and_failures() -> None:
    tracker = SmokeOutputTracker()
    tracker.feed('  ➜  Local:   http://localhost:5173/\n')
    assert tracker.readiness_detected is True
    assert tracker.failure_detected is False

    bad = SmokeOutputTracker()
    bad.feed('Error: listen EADDRINUSE: address already in use :::4200\n')
    assert bad.failure_detected is True


@pytest.mark.asyncio
async def test_wait_for_smoke_completion_stops_on_readiness() -> None:
    tracker = SmokeOutputTracker()
    tracker.feed('\n  VITE v5.0.0  ready in 120 ms\n  ➜  Local:   http://localhost:5173/\n')

    class _Proc:
        returncode: int | None = None

        async def wait(self) -> int:
            await asyncio.sleep(30)
            return 0

    proc = _Proc()
    wait_task = asyncio.create_task(proc.wait())
    abort_task = asyncio.create_task(asyncio.Event().wait())

    async def _terminate(_proc: object) -> int:
        proc.returncode = -15
        wait_task.cancel()
        try:
            await wait_task
        except asyncio.CancelledError:
            pass
        return -15

    result = await wait_for_smoke_completion(
        proc,  # type: ignore[arg-type]
        wait_task=wait_task,
        abort_task=abort_task,
        tracker=tracker,
        terminate_fn=_terminate,
        watch_mode=True,
        steady_state_sec=30,
        readiness_settle_sec=0,
    )

    assert result.passed is True
    assert result.readiness_detected is True
    assert result.stop_reason is SmokeStopReason.READINESS


@pytest.mark.asyncio
async def test_wait_for_smoke_completion_fails_on_error_output() -> None:
    tracker = SmokeOutputTracker()
    tracker.feed('npm ERR! code ELIFECYCLE\n')

    class _Proc:
        returncode: int | None = None

        async def wait(self) -> int:
            await asyncio.sleep(30)
            return 0

    proc = _Proc()
    wait_task = asyncio.create_task(proc.wait())
    abort_task = asyncio.create_task(asyncio.Event().wait())

    async def _terminate(_proc: object) -> int:
        proc.returncode = 1
        wait_task.cancel()
        try:
            await wait_task
        except asyncio.CancelledError:
            pass
        return 1

    result = await wait_for_smoke_completion(
        proc,  # type: ignore[arg-type]
        wait_task=wait_task,
        abort_task=abort_task,
        tracker=tracker,
        terminate_fn=_terminate,
        watch_mode=True,
        steady_state_sec=30,
        readiness_settle_sec=0,
    )

    assert result.passed is False
    assert result.stop_reason is SmokeStopReason.FAILURE_OUTPUT
