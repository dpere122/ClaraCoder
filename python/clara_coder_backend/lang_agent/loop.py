"""Shared loop policy and outcome helpers for agent streaming."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class AgentLoopOutcome(str, Enum):
    """Terminal state for one streamed outer-agent turn."""

    RUNNING = 'running'
    COMPLETED = 'completed'
    ABORTED = 'aborted'
    FAILED_CONFIGURATION = 'failed_configuration'
    FAILED_RUNTIME = 'failed_runtime'


@dataclass(frozen=True)
class AgentLoopPolicy:
    """Centralized policy for deciding how turn outcomes should be committed."""

    history_commit_outcomes: frozenset[AgentLoopOutcome] = field(
        default_factory=lambda: frozenset({AgentLoopOutcome.COMPLETED})
    )
    history_commit_requires_text: bool = True

    def should_commit_history(self, outcome: 'LangGraphWorkerOutcome') -> bool:
        if outcome.state not in self.history_commit_outcomes:
            return False
        if not self.history_commit_requires_text:
            return True
        return bool(outcome.best_available_text().strip())


DEFAULT_AGENT_LOOP_POLICY = AgentLoopPolicy()


@dataclass
class LangGraphWorkerOutcome:
    """Observed state and best-known text for one LangGraph-backed turn."""

    state: AgentLoopOutcome = AgentLoopOutcome.RUNNING
    final_text: str = ''
    partial_text: str = ''
    error_detail: str = ''

    def best_available_text(self) -> str:
        final_text = self.final_text.strip()
        if final_text:
            return self.final_text
        return self.partial_text

    def mark_completed(self, *, final_text: str, partial_text: str = '') -> None:
        self.state = AgentLoopOutcome.COMPLETED
        self.final_text = final_text
        self.partial_text = partial_text
        self.error_detail = ''

    def mark_aborted(self, *, partial_text: str = '') -> None:
        self.state = AgentLoopOutcome.ABORTED
        if partial_text:
            self.partial_text = partial_text
        self.final_text = ''
        self.error_detail = ''

    def mark_failed_configuration(self, detail: str, *, final_text: str = '') -> None:
        self.state = AgentLoopOutcome.FAILED_CONFIGURATION
        self.error_detail = detail
        self.final_text = final_text

    def mark_failed_runtime(self, detail: str, *, final_text: str = '', partial_text: str = '') -> None:
        self.state = AgentLoopOutcome.FAILED_RUNTIME
        self.error_detail = detail
        self.final_text = final_text
        if partial_text:
            self.partial_text = partial_text


class NestedWorkerRunState(str, Enum):
    """Structured result for one nested worker attempt (legacy nested-router types)."""

    COMPLETED = 'completed'
    RETRY = 'retry'
    RETRY_EXHAUSTED = 'retry_exhausted'
    ABORTED = 'aborted'
    FAILED = 'failed'


@dataclass
class NestedWorkerRunResult:
    """Outcome returned by nested worker middleware for one or more attempts (legacy)."""

    state: NestedWorkerRunState
    output_text: str
    next_task_summary: str = ''
    reentry_attempts: int = 0
    retry_budget: int = 0


def normalize_retry_budget(value: Any, *, minimum: int = 0) -> int:
    """Best-effort integer coercion for retry settings."""

    try:
        return max(minimum, int(value))
    except Exception:
        return minimum
