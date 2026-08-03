"""Tests for the fail-open command risk-assessment side LLM call."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from clara_coder_backend.hitl.accept_command import ACCEPT_COMMAND_KIND_DEFERRED_TOOL
from clara_coder_backend.hitl.command_risk_assess import (
    CommandRiskAssessment,
    assess_command_risk,
    maybe_enrich_pending_command_risk,
)
from clara_coder_backend.session.state import runtime_config


# ---------------------------------------------------------------------------
# assess_command_risk
# ---------------------------------------------------------------------------


@patch('clara_coder_backend.hitl.command_risk_assess._risk_assessment_chain')
@pytest.mark.asyncio(loop_scope='function')
async def test_assess_command_risk_returns_structured_result(mock_chain_factory: AsyncMock) -> None:
    mock_chain = AsyncMock()
    mock_chain.ainvoke.return_value = CommandRiskAssessment(
        description='Lists files in the current directory.',
        risk='low',
    )
    mock_chain_factory.return_value = mock_chain

    result = await assess_command_risk('ls -la', '/workspace')

    assert result is not None
    assert result.risk == 'low'
    assert 'Lists files' in result.description
    mock_chain.ainvoke.assert_awaited_once_with({'command': 'ls -la', 'cwd': '/workspace'})


@patch('clara_coder_backend.hitl.command_risk_assess._risk_assessment_chain')
@pytest.mark.asyncio(loop_scope='function')
async def test_assess_command_risk_returns_none_on_exception(mock_chain_factory: AsyncMock) -> None:
    mock_chain = AsyncMock()
    mock_chain.ainvoke.side_effect = RuntimeError('boom')
    mock_chain_factory.return_value = mock_chain

    result = await assess_command_risk('rm -rf /', '/workspace')

    assert result is None


@patch('clara_coder_backend.hitl.command_risk_assess.CLARA_COMMAND_RISK_ASSESS_TIMEOUT_SEC', 0.01)
@patch('clara_coder_backend.hitl.command_risk_assess._risk_assessment_chain')
@pytest.mark.asyncio(loop_scope='function')
async def test_assess_command_risk_returns_none_on_timeout(mock_chain_factory: AsyncMock) -> None:
    async def _slow_ainvoke(_payload: dict) -> CommandRiskAssessment:
        await asyncio.sleep(1)
        return CommandRiskAssessment(description='never gets here', risk='low')

    mock_chain = AsyncMock()
    mock_chain.ainvoke.side_effect = _slow_ainvoke
    mock_chain_factory.return_value = mock_chain

    result = await assess_command_risk('sleep 60', '/workspace')

    assert result is None


@patch('clara_coder_backend.hitl.command_risk_assess.asyncio.wait_for', side_effect=asyncio.TimeoutError)
@patch('clara_coder_backend.hitl.command_risk_assess._risk_assessment_chain')
@pytest.mark.asyncio(loop_scope='function')
async def test_assess_command_risk_returns_none_when_wait_for_times_out(
    mock_chain_factory: AsyncMock,
    _mock_wait_for: AsyncMock,
) -> None:
    mock_chain_factory.return_value = AsyncMock()

    result = await assess_command_risk('sleep 60', '/workspace')

    assert result is None


# ---------------------------------------------------------------------------
# maybe_enrich_pending_command_risk
# ---------------------------------------------------------------------------


def _deferred_run_command_pending(**overrides: object) -> dict:
    pending = {
        'kind': ACCEPT_COMMAND_KIND_DEFERRED_TOOL,
        'action': {
            'tool_name': 'run_command',
            'tool_input': {'command': 'ls -la', 'cwd': '.'},
        },
    }
    pending.update(overrides)
    return pending


@pytest.mark.asyncio(loop_scope='function')
async def test_maybe_enrich_noop_when_setting_off(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runtime_config.tools, 'command_line_explain_step', False, raising=False)
    pending = _deferred_run_command_pending()
    before = dict(pending)

    with patch('clara_coder_backend.hitl.command_risk_assess.assess_command_risk') as mock_assess:
        await maybe_enrich_pending_command_risk(pending)

    mock_assess.assert_not_called()
    assert pending == before


@pytest.mark.asyncio(loop_scope='function')
async def test_maybe_enrich_noop_when_kind_not_deferred_tool(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runtime_config.tools, 'command_line_explain_step', True, raising=False)
    pending = _deferred_run_command_pending(kind='python_dependency')
    before = dict(pending)

    with patch('clara_coder_backend.hitl.command_risk_assess.assess_command_risk') as mock_assess:
        await maybe_enrich_pending_command_risk(pending)

    mock_assess.assert_not_called()
    assert pending == before


@pytest.mark.asyncio(loop_scope='function')
async def test_maybe_enrich_noop_when_tool_name_not_run_command(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runtime_config.tools, 'command_line_explain_step', True, raising=False)
    pending = _deferred_run_command_pending()
    pending['action']['tool_name'] = 'run_staging_overlay_command'
    before = dict(pending)

    with patch('clara_coder_backend.hitl.command_risk_assess.assess_command_risk') as mock_assess:
        await maybe_enrich_pending_command_risk(pending)

    mock_assess.assert_not_called()
    assert pending == before


@pytest.mark.asyncio(loop_scope='function')
async def test_maybe_enrich_noop_when_already_assessed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runtime_config.tools, 'command_line_explain_step', True, raising=False)
    pending = _deferred_run_command_pending(risk_assessment_status='ok', risk_level='low', risk_description='x')
    before = dict(pending)

    with patch('clara_coder_backend.hitl.command_risk_assess.assess_command_risk') as mock_assess:
        await maybe_enrich_pending_command_risk(pending)

    mock_assess.assert_not_called()
    assert pending == before


@pytest.mark.asyncio(loop_scope='function')
async def test_maybe_enrich_sets_ok_fields_on_success(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runtime_config.tools, 'command_line_explain_step', True, raising=False)
    pending = _deferred_run_command_pending()

    with patch(
        'clara_coder_backend.hitl.command_risk_assess.assess_command_risk',
        new=AsyncMock(
            return_value=CommandRiskAssessment(description='Lists files.', risk='medium'),
        ),
    ) as mock_assess:
        await maybe_enrich_pending_command_risk(pending)

    mock_assess.assert_awaited_once_with('ls -la', '.')
    assert pending['risk_assessment_status'] == 'ok'
    assert pending['risk_level'] == 'medium'
    assert pending['risk_description'] == 'Lists files.'


@pytest.mark.asyncio(loop_scope='function')
async def test_maybe_enrich_sets_failed_status_when_assess_returns_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(runtime_config.tools, 'command_line_explain_step', True, raising=False)
    pending = _deferred_run_command_pending()

    with patch(
        'clara_coder_backend.hitl.command_risk_assess.assess_command_risk',
        new=AsyncMock(return_value=None),
    ):
        await maybe_enrich_pending_command_risk(pending)

    assert pending['risk_assessment_status'] == 'failed'
    assert 'risk_level' not in pending
    assert 'risk_description' not in pending
