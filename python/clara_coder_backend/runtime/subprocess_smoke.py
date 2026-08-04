"""Shared smoke-test handling for watch-mode dev processes (Vite, electronmon, etc.)."""

from __future__ import annotations

import asyncio
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING

from clara_coder_backend.config import CLARA_SMOKE_READINESS_SETTLE_SEC, CLARA_SMOKE_STEADY_STATE_SEC

if TYPE_CHECKING:
    import asyncio.subprocess

EmitStatusFn = Callable[[str], Awaitable[None]]
TerminateFn = Callable[[asyncio.subprocess.Process], Awaitable[int | None]]

_WATCH_FALSE_RE = re.compile(r'^--watch=(false|0|no|off)$', re.I)

_READINESS_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r'ready in \d+', re.I),
    re.compile(r'Local:\s+https?://', re.I),
    re.compile(r'Compiled successfully', re.I),
    re.compile(r'webpack compiled', re.I),
    re.compile(r'Application bundle generation complete', re.I),
    re.compile(r'Angular Live Development Server is listening', re.I),
    re.compile(r'Dev server running', re.I),
    re.compile(r'listening on (?:https?://|port|\d)', re.I),
    re.compile(r'started server on', re.I),
    re.compile(r'Watching for file changes', re.I),
    re.compile(r'\[electronmon\].*restarting', re.I),
    re.compile(r'electronmon.*restarting', re.I),
)

_FAILURE_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r'EADDRINUSE', re.I),
    re.compile(r'Cannot find module', re.I),
    re.compile(r'Module not found', re.I),
    re.compile(r'FATAL ERROR', re.I),
    re.compile(r'error TS\d+:', re.I),
    re.compile(r'npm ERR!', re.I),
    re.compile(r'failed with exit code [1-9]\d*', re.I),
    re.compile(r'ELIFECYCLE.*Command failed', re.I),
)


class SmokeStopReason(str, Enum):
    EXITED = 'exited'
    READINESS = 'readiness'
    STEADY_STATE = 'steady_state'
    FAILURE_OUTPUT = 'failure_output'
    ABORTED = 'aborted'


@dataclass(frozen=True)
class SmokeRunResult:
    exit_code: int | None
    steady_state: bool
    readiness_detected: bool
    passed: bool
    stop_reason: SmokeStopReason
    failure_detail: str = ''


class SmokeOutputTracker:
    """Incrementally scan multiplexed stdout/stderr for readiness or failure signals."""

    def __init__(self) -> None:
        self._parts: list[str] = []
        self.readiness_detected = False
        self.failure_detected = False
        self.failure_detail = ''

    def feed(self, text: str) -> None:
        if not text:
            return
        self._parts.append(text)
        combined = self.combined
        if not self.failure_detected:
            for pattern in _FAILURE_PATTERNS:
                match = pattern.search(combined)
                if match:
                    self.failure_detected = True
                    start = max(0, match.start() - 40)
                    end = min(len(combined), match.end() + 120)
                    self.failure_detail = combined[start:end].strip()
                    return
        if not self.readiness_detected:
            for pattern in _READINESS_PATTERNS:
                if pattern.search(combined):
                    self.readiness_detected = True
                    return

    @property
    def combined(self) -> str:
        return ''.join(self._parts)


def argv_implies_watch_mode(argv: list[str]) -> bool:
    """Return True when ``argv`` would start a long-lived watch/reload dev process."""

    if not argv:
        return False
    lowered = [str(a).lower() for a in argv]
    joined = ' '.join(lowered)
    for i, arg in enumerate(lowered):
        if arg in ('electronmon', 'vite', 'webpack-dev-server'):
            return True
        if arg == 'serve' and i > 0 and lowered[i - 1] in ('ng', 'npm', 'pnpm', 'yarn', 'npx'):
            return True
        if arg == 'webpack' and i + 1 < len(lowered) and lowered[i + 1] == 'serve':
            return True
        if arg == '--watch' or arg.startswith('--watch='):
            if _WATCH_FALSE_RE.match(arg) or arg.endswith('=false') or arg.endswith('=0'):
                continue
            return True
        if arg == '-w' and 'tsc' in joined:
            return True
    if 'concurrently' in lowered and any(token in joined for token in ('watch', 'electronmon', 'vite', 'ng start')):
        return True
    if 'wait-on' in lowered and ('electronmon' in joined or ' electron ' in f' {joined} '):
        return True
    exe = _path_basename(lowered[0])
    if exe in ('npm', 'npm.cmd', 'pnpm', 'pnpm.cmd', 'yarn', 'yarn.cmd', 'npx', 'npx.cmd'):
        if 'run' in lowered:
            run_idx = lowered.index('run')
            if run_idx + 1 < len(lowered):
                script = lowered[run_idx + 1]
                if script in ('dev', 'start', 'serve', 'preview'):
                    return True
    return False


def _path_basename(token: str) -> str:
    return token.rsplit('/', 1)[-1].rsplit('\\', 1)[-1]


def smoke_status_message(result: SmokeRunResult) -> str:
    if result.stop_reason is SmokeStopReason.ABORTED:
        return '\n[smoke test aborted by user]\n'
    if result.stop_reason is SmokeStopReason.FAILURE_OUTPUT:
        detail = result.failure_detail or 'failure pattern in output'
        return f'\n[smoke test failed: {detail}]\n'
    if result.stop_reason is SmokeStopReason.READINESS:
        return '\n[smoke test detected dev-server readiness; stopping watch process]\n'
    if result.stop_reason is SmokeStopReason.STEADY_STATE:
        return '\n[smoke test reached steady state; stopping watch process]\n'
    return ''


async def _await_wait_task(wait_task: asyncio.Task[int]) -> int | None:
    if wait_task.cancelled():
        return None
    if wait_task.done():
        try:
            return wait_task.result()
        except asyncio.CancelledError:
            return None
    try:
        return await wait_task
    except asyncio.CancelledError:
        return None


async def wait_for_smoke_completion(
    proc: asyncio.subprocess.Process,
    *,
    wait_task: asyncio.Task[int],
    abort_task: asyncio.Task[None],
    tracker: SmokeOutputTracker,
    terminate_fn: TerminateFn,
    emit_status: EmitStatusFn | None = None,
    watch_mode: bool = False,
    steady_state_sec: float | None = None,
    readiness_settle_sec: float | None = None,
) -> SmokeRunResult:
    """Wait until a smoke subprocess exits, fails, reaches readiness, or hits steady-state."""

    steady = float(steady_state_sec if steady_state_sec is not None else CLARA_SMOKE_STEADY_STATE_SEC)
    settle = float(readiness_settle_sec if readiness_settle_sec is not None else CLARA_SMOKE_READINESS_SETTLE_SEC)
    loop = asyncio.get_running_loop()
    started = loop.time()
    readiness_at: float | None = None

    while True:
        if tracker.failure_detected:
            if emit_status:
                await emit_status(smoke_status_message(
                    SmokeRunResult(None, False, False, False, SmokeStopReason.FAILURE_OUTPUT, tracker.failure_detail)
                ))
            exit_code = await terminate_fn(proc)
            await _await_wait_task(wait_task)
            return SmokeRunResult(
                exit_code=exit_code,
                steady_state=False,
                readiness_detected=False,
                passed=False,
                stop_reason=SmokeStopReason.FAILURE_OUTPUT,
                failure_detail=tracker.failure_detail,
            )

        if abort_task.done():
            if emit_status:
                await emit_status(smoke_status_message(
                    SmokeRunResult(None, False, False, False, SmokeStopReason.ABORTED)
                ))
            exit_code = await terminate_fn(proc)
            await _await_wait_task(wait_task)
            return SmokeRunResult(
                exit_code=exit_code,
                steady_state=False,
                readiness_detected=False,
                passed=False,
                stop_reason=SmokeStopReason.ABORTED,
            )

        if wait_task.done():
            exit_code = await _await_wait_task(wait_task)
            passed = exit_code == 0 and not tracker.failure_detected
            return SmokeRunResult(
                exit_code=exit_code,
                steady_state=False,
                readiness_detected=tracker.readiness_detected,
                passed=passed,
                stop_reason=SmokeStopReason.EXITED,
                failure_detail=tracker.failure_detail if not passed else '',
            )

        now = loop.time()
        if tracker.readiness_detected:
            if readiness_at is None:
                readiness_at = now
            elif now - readiness_at >= settle:
                if emit_status:
                    await emit_status(smoke_status_message(
                        SmokeRunResult(None, True, True, True, SmokeStopReason.READINESS)
                    ))
                exit_code = await terminate_fn(proc)
                await _await_wait_task(wait_task)
                return SmokeRunResult(
                    exit_code=exit_code,
                    steady_state=True,
                    readiness_detected=True,
                    passed=True,
                    stop_reason=SmokeStopReason.READINESS,
                )
        elif now - started >= steady and (watch_mode or proc.returncode is None):
            if emit_status:
                await emit_status(smoke_status_message(
                    SmokeRunResult(None, True, False, True, SmokeStopReason.STEADY_STATE)
                ))
            exit_code = await terminate_fn(proc)
            await _await_wait_task(wait_task)
            return SmokeRunResult(
                exit_code=exit_code,
                steady_state=True,
                readiness_detected=False,
                passed=True,
                stop_reason=SmokeStopReason.STEADY_STATE,
            )

        slice_sec = 0.15
        if readiness_at is not None:
            slice_sec = min(slice_sec, max(0.05, settle - (now - readiness_at)))
        elif steady > 0:
            slice_sec = min(slice_sec, max(0.05, steady - (now - started)))

        done, _pending = await asyncio.wait(
            {wait_task, abort_task},
            timeout=slice_sec,
            return_when=asyncio.FIRST_COMPLETED,
        )
        if done:
            continue
