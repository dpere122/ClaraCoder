"""Tests for plan probe, fast path orchestration, and programming-path / LSP scope helpers."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from nemo_backend.agents.coding_planner.pipeline import (
    _parse_plan_steps,
    _validate_probe_plan_steps,
    run_coding_planner_orchestrated_stream,
    scope_text_mentions_programming_paths,
)
from nemo_backend.domain import SessionState


def test_scope_text_mentions_programming_paths_py() -> None:
    assert scope_text_mentions_programming_paths('Edit `src/foo.py`') is True
    assert scope_text_mentions_programming_paths('Touch `app.ts`') is True


def test_scope_text_mentions_programming_paths_non_code() -> None:
    assert scope_text_mentions_programming_paths('Update README.md') is False


def test_scope_text_mentions_programming_paths_config() -> None:
    assert scope_text_mentions_programming_paths('Change `docs/config.yaml`') is True


def test_validate_probe_plan_steps_accepts_build_steps() -> None:
    parsed = _parse_plan_steps('1. Add helper in utils.py\n2. Wire caller in main.py')
    assert _validate_probe_plan_steps(parsed) is None


def test_validate_probe_plan_steps_rejects_read_only() -> None:
    parsed = _parse_plan_steps('1. read the configuration file')
    assert _validate_probe_plan_steps(parsed) == 'read-only step'


@pytest.mark.asyncio(loop_scope='function')
async def test_orchestrator_two_step_probe_uses_fast_path() -> None:
    session = SessionState()
    nested_q: asyncio.Queue = asyncio.Queue()
    with (
        patch('nemo_backend.agents.coding_planner.orchestrator.run_plan_probe_llm', new_callable=AsyncMock) as probe,
        patch(
            'nemo_backend.agents.coding_planner.orchestrator.run_coding_planner_fast_path_stream',
            new_callable=AsyncMock,
        ) as fast,
        patch(
            'nemo_backend.agents.coding_planner.orchestrator.run_coding_planner_deterministic_stream',
            new_callable=AsyncMock,
        ) as full,
    ):
        probe.return_value = ['Implement feature A', 'Add test for A']
        fast.return_value = 'fast-done'
        out = await run_coding_planner_orchestrated_stream(
            session,
            'sess-orch',
            'small change in `foo.py`',
            nested_q,
            None,
        )
    assert out == 'fast-done'
    probe.assert_awaited_once()
    fast.assert_awaited_once()
    full.assert_not_awaited()


@pytest.mark.asyncio(loop_scope='function')
async def test_orchestrator_four_step_probe_uses_full_planner() -> None:
    session = SessionState()
    nested_q: asyncio.Queue = asyncio.Queue()
    with (
        patch('nemo_backend.agents.coding_planner.orchestrator.run_plan_probe_llm', new_callable=AsyncMock) as probe,
        patch(
            'nemo_backend.agents.coding_planner.orchestrator.run_coding_planner_fast_path_stream',
            new_callable=AsyncMock,
        ) as fast,
        patch(
            'nemo_backend.agents.coding_planner.orchestrator.run_coding_planner_deterministic_stream',
            new_callable=AsyncMock,
        ) as full,
    ):
        probe.return_value = ['s1', 's2', 's3', 's4']
        full.return_value = 'full-done'
        out = await run_coding_planner_orchestrated_stream(session, 'sess-orch', 'big task', nested_q, None)
    assert out == 'full-done'
    fast.assert_not_awaited()
    full.assert_awaited_once()


@pytest.mark.asyncio(loop_scope='function')
async def test_orchestrator_skips_probe_when_disabled() -> None:
    session = SessionState()
    nested_q: asyncio.Queue = asyncio.Queue()
    with (
        patch('nemo_backend.config.NEMO_PLAN_PROBE_ENABLED', False),
        patch('nemo_backend.agents.coding_planner.orchestrator.run_plan_probe_llm', new_callable=AsyncMock) as probe,
        patch(
            'nemo_backend.agents.coding_planner.orchestrator.run_coding_planner_deterministic_stream',
            new_callable=AsyncMock,
        ) as full,
    ):
        full.return_value = 'only-full'
        out = await run_coding_planner_orchestrated_stream(session, 'sess-orch', 'any', nested_q, None)
    assert out == 'only-full'
    probe.assert_not_awaited()
    full.assert_awaited_once()


@pytest.mark.asyncio(loop_scope='function')
async def test_orchestrator_skips_probe_when_complexity_max_steps_high() -> None:
    session = SessionState()
    nested_q: asyncio.Queue = asyncio.Queue()
    prof = MagicMock()
    prof.max_steps = 6
    with (
        patch('nemo_backend.agents.coding_planner.orchestrator.task_complexity_profile', return_value=prof),
        patch('nemo_backend.agents.coding_planner.orchestrator.run_plan_probe_llm', new_callable=AsyncMock) as probe,
        patch(
            'nemo_backend.agents.coding_planner.orchestrator.run_coding_planner_deterministic_stream',
            new_callable=AsyncMock,
        ) as full,
    ):
        full.return_value = 'full'
        await run_coding_planner_orchestrated_stream(session, 'sess-orch', 'task', nested_q, None)
    probe.assert_not_awaited()
    full.assert_awaited_once()
