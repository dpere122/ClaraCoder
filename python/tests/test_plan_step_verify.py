from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from nemo_backend.plan_execute import build_step_task_prompt
from nemo_backend.plan_step_verify import StepVerifyResult, invoke_step_verifier


def test_build_step_task_prompt_includes_verifier_feedback() -> None:
    prompt = build_step_task_prompt(['Fix bug'], 0, verifier_feedback='Add a unit test.')
    assert 'Verifier feedback' in prompt
    assert 'Add a unit test.' in prompt


@patch('nemo_backend.plan_step_verify._step_verifier_chain')
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
