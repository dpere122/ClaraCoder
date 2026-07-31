from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from langchain_core.messages import AIMessage

from clara_coder_backend.empty_response_middleware import EmptyResponseNudgeMiddleware
from clara_coder_backend.messages import text_ends_with_unfulfilled_action_commitment


@pytest.mark.parametrize(
    'text',
    [
        "I'll now check the config file for that setting.",
        'Let me search for the relevant tests and run them.',
        "Sure, here's what I found so far. Next, I'll implement the fix in the config module.",
        "I'm going to open the file and take a look.",
        "Let's start by reading the workspace tree.",
    ],
)
def test_detects_unfulfilled_action_commitment(text: str) -> None:
    assert text_ends_with_unfulfilled_action_commitment(text) is True


@pytest.mark.parametrize(
    'text',
    [
        '',
        '   ',
        'Here is the answer: the bug was a missing null check on line 42.',
        'Let me know if you have any other questions!',
        "I've already checked the file and it looks correct.",
        'The function returns `None` when the list is empty.',
        # Genuine "I will" phrasing that is not a bare, unfulfilled commitment (long trailing context).
        'I will keep this brief: the setting lives in config.py and defaults to 400 steps, '
        'which should be enough for most sessions and rarely needs to be raised in practice.',
    ],
)
def test_does_not_flag_real_answers(text: str) -> None:
    assert text_ends_with_unfulfilled_action_commitment(text) is False


@pytest.mark.asyncio(loop_scope='function')
async def test_action_commitment_nudge_fires_without_tool_calls() -> None:
    middleware = EmptyResponseNudgeMiddleware()
    result = await middleware.aafter_model(
        {
            'messages': [AIMessage(content="I'll now check the config file for that setting.")],
            'action_commitment_nudge_streak': 0,
        },
        MagicMock(),
    )
    assert result is not None
    assert result.get('jump_to') == 'model'
    assert result.get('action_commitment_nudge_streak') == 1
    assert result.get('empty_response_nudge_streak') == 0
    assert 'issue the actual tool call now' in result['messages'][0].content.lower()


@pytest.mark.asyncio(loop_scope='function')
async def test_action_commitment_nudge_does_not_fire_with_tool_calls() -> None:
    middleware = EmptyResponseNudgeMiddleware()
    result = await middleware.aafter_model(
        {
            'messages': [
                AIMessage(
                    content="I'll now check the config file for that setting.",
                    tool_calls=[{'name': 'read_workspace_file', 'args': {'relative_path': 'config.py'}, 'id': 'tool-1'}],
                )
            ],
            'action_commitment_nudge_streak': 1,
        },
        MagicMock(),
    )
    assert result == {
        'empty_response_nudge_streak': 0,
        'pseudo_tool_markup_nudge_streak': 0,
        'staging_continuation_nudge_streak': 0,
        'action_commitment_nudge_streak': 0,
    }


@pytest.mark.asyncio(loop_scope='function')
@patch('clara_coder_backend.empty_response_middleware.MAX_AGENT_ACTION_COMMITMENT_NUDGES', 2)
async def test_action_commitment_nudge_stops_at_cap_and_lets_turn_end() -> None:
    middleware = EmptyResponseNudgeMiddleware()
    result = await middleware.aafter_model(
        {
            'messages': [AIMessage(content="I'll now check the config file for that setting.")],
            'action_commitment_nudge_streak': 2,
        },
        MagicMock(),
    )
    # Cap reached: falls through to the generic "has visible text" reset, no further jump.
    assert result is not None
    assert result.get('jump_to') is None
    assert result == {
        'empty_response_nudge_streak': 0,
        'pseudo_tool_markup_nudge_streak': 0,
        'staging_continuation_nudge_streak': 0,
        'action_commitment_nudge_streak': 0,
    }


@pytest.mark.asyncio(loop_scope='function')
async def test_real_answer_resets_action_commitment_streak() -> None:
    middleware = EmptyResponseNudgeMiddleware()
    result = await middleware.aafter_model(
        {
            'messages': [AIMessage(content='Here is a normal answer for the user.')],
            'action_commitment_nudge_streak': 1,
        },
        MagicMock(),
    )
    assert result == {
        'empty_response_nudge_streak': 0,
        'pseudo_tool_markup_nudge_streak': 0,
        'staging_continuation_nudge_streak': 0,
        'action_commitment_nudge_streak': 0,
    }
