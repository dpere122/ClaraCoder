from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from clara_coder_backend.plan_execute import build_build_plan_executor_prompt
from clara_coder_backend.plan_step_verify import StepVerifyResult, invoke_step_verifier


def test_build_build_plan_executor_prompt_mentions_mark_tool() -> None:
    prompt = build_build_plan_executor_prompt('.nemo/build-plans/plan-1.md')
    assert 'mark_build_plan_steps_complete' in prompt
    assert 'read_build_plan' in prompt


@patch('clara_coder_backend.plan_step_verify._step_verifier_chain')
@pytest.mark.asyncio(loop_scope='function')
async def test_invoke_step_verifier_returns_structured_result(mock_chain_factory: AsyncMock) -> None:
    mock_chain = AsyncMock()
    mock_chain.ainvoke.return_value = StepVerifyResult(
        approved=False,
        evidence='No file was edited.',
        feedback='Apply the patch to src/foo.ts.',
    )
    mock_chain_factory.return_value = mock_chain

    result = await invoke_step_verifier(
        objective='Fix the bug',
        plan_steps=['Edit src/foo.ts'],
        step_index=0,
        executor_summary='I will edit the file next.',
    )

    assert result.approved is False
    assert 'patch' in result.feedback.lower()
    mock_chain.ainvoke.assert_awaited_once()
