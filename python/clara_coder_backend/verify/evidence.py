"""Gather what a finished editing turn left behind: new LSP errors and failing check commands."""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from clara_coder_backend.lsp.diagnostics import diagnostic_error_keys, format_diagnostics_summary
from clara_coder_backend.lsp.file_policy import lsp_server_for_path
from clara_coder_backend.session.state import runtime_config
from clara_coder_backend.verify.checks_config import WorkspaceCheck, WorkspaceChecks, check_applies
from clara_coder_backend.workspace.meta import CHECKS_RELATIVE_PATH
from clara_coder_backend.workspace.paths import truncate_text_head_tail
from clara_coder_backend.workspace.trust import workspace_is_trusted

__all__ = [
    'CheckOutcome',
    'DiagnosticsEvidence',
    'FEEDBACK_HEADER',
    'VerificationResult',
    'collect_diagnostics',
    'format_feedback',
    'gather_evidence',
    'run_checks',
]

logger = logging.getLogger('clara.verify.evidence')

#: Touched paths past this many are not sent through the language servers.
MAX_DIAGNOSTIC_PATHS = 25
#: Stop asking language servers once this much time went into it (each first open can take seconds).
DIAGNOSTICS_BUDGET_SEC = 60.0
_FEEDBACK_MAX_DIAGNOSTIC_ROWS = 30
_FEEDBACK_CHECK_OUTPUT_CHARS = 4_000
_FEEDBACK_MAX_CHARS = 12_000
#: First line of the message that hands a failed verification back to the model (also how it is recognized).
FEEDBACK_HEADER = 'Automatic verification (from the app, not from the user) found problems after your changes this turn.'
_ANSI_ESCAPE_RE = re.compile(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]')


@dataclass
class DiagnosticsEvidence:
    #: Error rows by path that were not there before the turn's first edit of that path.
    new_errors: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    #: Errors the path already had before the turn touched it.
    preexisting: int = 0
    checked_paths: int = 0
    notes: list[str] = field(default_factory=list)

    @property
    def new_error_count(self) -> int:
        return sum(len(rows) for rows in self.new_errors.values())


@dataclass
class CheckOutcome:
    check: WorkspaceCheck
    passed: bool
    #: Short reason shown to the user and the model, e.g. ``exit code 1`` or ``timed out after 120s``.
    reason: str = ''
    output: str = ''
    duration_sec: float = 0.0


@dataclass
class VerificationResult:
    diagnostics: DiagnosticsEvidence = field(default_factory=DiagnosticsEvidence)
    checks: list[CheckOutcome] = field(default_factory=list)
    #: Things that were not verified and why (untrusted workspace, ignored entries of the checks file…).
    notes: list[str] = field(default_factory=list)
    #: The turn was stopped while gathering; the result is incomplete and must not be acted on.
    stopped: bool = False

    @property
    def failed_checks(self) -> list[CheckOutcome]:
        return [outcome for outcome in self.checks if not outcome.passed]

    @property
    def failed(self) -> bool:
        return bool(self.failed_checks) or self.diagnostics.new_error_count > 0

    @property
    def verified_anything(self) -> bool:
        return bool(self.checks) or self.diagnostics.checked_paths > 0

    def summary(self) -> str:
        """One line for the transcript pill, failures first (the pill shows only its start)."""
        parts = [f'{outcome.check.name} failed ({outcome.reason})' for outcome in self.failed_checks]
        errors = self.diagnostics.new_error_count
        if errors:
            files = len(self.diagnostics.new_errors)
            parts.append(f"{errors} new error{'s' if errors != 1 else ''} in {files} file{'s' if files != 1 else ''}")
        elif self.diagnostics.checked_paths:
            parts.append('no new errors')
        parts.extend(f'{outcome.check.name} passed' for outcome in self.checks if outcome.passed)
        parts.extend(self.notes)
        return ' · '.join(parts)


def _sync_path(session_id: str, server: str, relative_path: str, encoding: str) -> tuple[list[dict[str, Any]], bool, str]:
    """Blocking: bring the server in line with disk and return ``(rows, fresh, off_reason)``."""
    from clara_coder_backend.lsp.manager import get_session_lsp_manager

    manager = get_session_lsp_manager(session_id, server=server, scope='workspace', set_active=False)
    off_reason = manager.diagnostics_off_reason(relative_path)
    if off_reason:
        return [], True, off_reason
    rows = manager.sync_for_agent(relative_path, encoding=encoding, wait_for_diagnostics=True)
    if not manager.diagnostics_fresh(relative_path):
        # Still analyzing: one more wait, then take what the server has.
        rows = manager.sync_for_agent(relative_path, encoding=encoding, wait_for_diagnostics=True)
    return rows, manager.diagnostics_fresh(relative_path), ''


def _baseline_keys(session_id: str, server: str, relative_path: str, before_text: str) -> list[str]:
    """Blocking: the error keys the server reports for the path's text before the turn's first edit.

    The server gets that text as the open document; :func:`_sync_path` brings it back to disk next.
    """
    from clara_coder_backend.lsp.manager import get_session_lsp_manager

    manager = get_session_lsp_manager(session_id, server=server, scope='workspace', set_active=False)
    if manager.diagnostics_off_reason(relative_path):
        return []
    rows = manager.sync_document(relative_path, before_text, wait_for_diagnostics=True)
    if not manager.diagnostics_fresh(relative_path):
        rows = manager.sync_document(relative_path, before_text, wait_for_diagnostics=True)
    return diagnostic_error_keys(rows)


async def collect_diagnostics(
    session_id: str,
    workspace_root: Path,
    touched_paths: list[str],
    baseline_errors: dict[str, list[str]],
    stop_event: asyncio.Event,
    baseline_texts: dict[str, str] | None = None,
) -> DiagnosticsEvidence:
    """Errors the language servers report on the touched files, minus the ones each file already had.

    ``baseline_texts`` holds the pre-edit text of paths whose earlier errors were not known when the
    turn first edited them; the server is asked about that text once and the result is stored in
    ``baseline_errors`` (both dicts are the turn's own bookkeeping, so later rounds reuse it).
    """

    evidence = DiagnosticsEvidence()
    encoding = (runtime_config.tools.default_workspace_encoding or 'utf-8').strip() or 'utf-8'
    candidates = [
        (rel, server)
        for rel in touched_paths
        if (server := lsp_server_for_path(rel)) and (workspace_root / rel).is_file()
    ]
    deadline = time.monotonic() + DIAGNOSTICS_BUDGET_SEC
    for index, (rel, server) in enumerate(candidates):
        if stop_event.is_set():
            break
        if index >= MAX_DIAGNOSTIC_PATHS or time.monotonic() > deadline:
            evidence.notes.append(f'diagnostics not checked for {len(candidates) - index} more file(s)')
            break
        before_text = baseline_texts.pop(rel, None) if baseline_texts else None
        if before_text is not None and rel not in baseline_errors:
            try:
                baseline_errors[rel] = await asyncio.to_thread(_baseline_keys, session_id, server, rel, before_text)
            except Exception as exc:  # Without a baseline every error counts as new, as before.
                logger.info('verification baseline skipped path=%s server=%s err=%s', rel, server, exc)
            if stop_event.is_set():
                break
        try:
            rows, fresh, off_reason = await asyncio.to_thread(_sync_path, session_id, server, rel, encoding)
        except Exception as exc:  # A server that cannot start must not fail the turn.
            logger.info('verification diagnostics skipped path=%s server=%s err=%s', rel, server, exc)
            evidence.notes.append(f'no {server} diagnostics for `{rel}`')
            continue
        if off_reason:
            continue
        evidence.checked_paths += 1
        if not fresh:
            evidence.notes.append(f'diagnostics for `{rel}` may be incomplete')
        known = Counter(baseline_errors.get(rel, ()))
        fresh_rows: list[dict[str, Any]] = []
        for row in rows:
            keys = diagnostic_error_keys([row])
            if not keys:
                continue
            if known[keys[0]] > 0:
                known[keys[0]] -= 1
                evidence.preexisting += 1
            else:
                fresh_rows.append(row)
        if fresh_rows:
            evidence.new_errors[rel] = fresh_rows
    return evidence


def _clean_output(text: str) -> str:
    return _ANSI_ESCAPE_RE.sub('', text or '').replace('\r\n', '\n').strip()


async def run_checks(
    session_id: str,
    workspace_root: Path,
    checks: list[WorkspaceCheck],
    stop_event: asyncio.Event,
) -> tuple[list[CheckOutcome], bool]:
    """Run each check to its end, one after another. Returns the outcomes and whether the turn was stopped."""
    from clara_coder_backend.tools.run_command import run_harness_command

    outcomes: list[CheckOutcome] = []
    for check in checks:
        if stop_event.is_set():
            return outcomes, True
        cwd = workspace_root / check.cwd if check.cwd else workspace_root
        if not cwd.is_dir():
            outcomes.append(CheckOutcome(check, False, reason=f'folder `{check.cwd}` does not exist'))
            continue
        result = await run_harness_command(
            session_id,
            command=check.command,
            cwd_label=check.cwd or '.',
            cwd=str(cwd),
            timeout_sec=float(check.timeout_seconds),
            stop_event=stop_event,
        )
        if result.stopped:
            return outcomes, True
        if result.start_error:
            reason = result.start_error.removeprefix('Tool error: ').rstrip('.')
        elif result.timed_out:
            reason = f'timed out after {check.timeout_seconds}s'
        else:
            reason = f'exit code {result.exit_code}'
        outcomes.append(
            CheckOutcome(
                check,
                result.passed,
                reason='' if result.passed else reason,
                output=_clean_output(result.output),
                duration_sec=result.duration_sec,
            )
        )
    return outcomes, False


async def gather_evidence(
    session_id: str,
    workspace_root: Path,
    *,
    touched_paths: list[str],
    baseline_errors: dict[str, list[str]],
    checks: WorkspaceChecks,
    stop_event: asyncio.Event,
    baseline_texts: dict[str, str] | None = None,
) -> VerificationResult:
    """Diagnostics on the touched files, then the applicable checks (only in a trusted workspace)."""

    result = VerificationResult()
    result.diagnostics = await collect_diagnostics(
        session_id, workspace_root, touched_paths, baseline_errors, stop_event, baseline_texts
    )
    result.notes.extend(result.diagnostics.notes)
    if stop_event.is_set():
        result.stopped = True
        return result
    result.notes.extend(f'{CHECKS_RELATIVE_PATH}: {problem}' for problem in checks.problems)
    applicable = [check for check in checks.enabled if check_applies(check, touched_paths)]
    if applicable and not workspace_is_trusted(workspace_root):
        result.notes.append('checks not run: this workspace is not trusted')
        return result
    result.checks, result.stopped = await run_checks(session_id, workspace_root, applicable, stop_event)
    return result


def format_feedback(result: VerificationResult, *, fix_round: int, max_rounds: int) -> str:
    """The message that hands a failed verification back to the model."""

    blocks: list[str] = [FEEDBACK_HEADER]
    for outcome in result.failed_checks:
        where = f' in `{outcome.check.cwd}`' if outcome.check.cwd else ''
        head = f'Check `{outcome.check.name}` failed ({outcome.reason}): `{outcome.check.command}`{where}'
        output = truncate_text_head_tail(outcome.output, _FEEDBACK_CHECK_OUTPUT_CHARS)
        blocks.append(f'{head}\n{output}' if output else head)
    rows_left = _FEEDBACK_MAX_DIAGNOSTIC_ROWS
    omitted = 0
    for rel, rows in result.diagnostics.new_errors.items():
        if rows_left <= 0:
            omitted += len(rows)
            continue
        shown = rows[:rows_left]
        omitted += len(rows) - len(shown)
        rows_left -= len(shown)
        blocks.append('New errors: ' + format_diagnostics_summary(rel, shown))
    if omitted:
        blocks.append(f'... {omitted} more new error(s) omitted.')
    blocks.append(
        'Fix these now, then finish. If one is not caused by your changes or cannot be fixed within this task, '
        'say so plainly in your reply instead of reporting success. '
        f'(Fix round {fix_round} of {max_rounds}.)'
    )
    return truncate_text_head_tail('\n\n'.join(blocks), _FEEDBACK_MAX_CHARS)
