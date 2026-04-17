from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage, ToolMessage

from nemo_backend.empty_response_middleware import EmptyResponseNudgeMiddleware


pytestmark = pytest.mark.asyncio(loop_scope='function')


async def test_empty_response_nudge_resets_after_tool_call() -> None:
    middleware = EmptyResponseNudgeMiddleware()

    result = await middleware.aafter_model(
        {
            'messages': [
                AIMessage(
                    content='',
                    tool_calls=[{'name': 'list_workspace_directory', 'args': {'relative_path': '.'}, 'id': 'tool-1'}],
                )
            ],
            'empty_response_nudge_streak': 2,
        },
        MagicMock(),
    )

    assert result == {'empty_response_nudge_streak': 0, 'post_tool_silent_tool_streak': 0}


async def test_empty_response_nudge_uses_nested_mutation_followup_prompt() -> None:
    middleware = EmptyResponseNudgeMiddleware()

    result = await middleware.aafter_model(
        {
            'messages': [
                ToolMessage(
                    content='Completed the requested workspace changes successfully.',
                    tool_call_id='tool-1',
                    name='plan_and_modify',
                ),
                AIMessage(content=''),
            ],
            'empty_response_nudge_streak': 0,
        },
        MagicMock(),
    )

    assert result is not None
    assert result['jump_to'] == 'model'
    assert result['empty_response_nudge_streak'] == 1
    assert 'nested workspace mutation result' in result['messages'][0].content
    assert 'answer the user now in plain language without more tools' in result['messages'][0].content


async def test_empty_response_nudge_after_successful_execute_workspace_mutation() -> None:
    middleware = EmptyResponseNudgeMiddleware()

    result = await middleware.aafter_model(
        {
            'messages': [
                ToolMessage(
                    content='Staged and transferred foo.py successfully.',
                    tool_call_id='tool-1',
                    name='execute_workspace_mutation',
                ),
                AIMessage(content=''),
            ],
            'empty_response_nudge_streak': 0,
        },
        MagicMock(),
    )

    assert result is not None
    assert result['jump_to'] == 'model'
    assert 'nested workspace mutation result' in result['messages'][0].content


async def test_post_tool_silent_streak_increments_once_before_nudge() -> None:
    middleware = EmptyResponseNudgeMiddleware()

    result = await middleware.aafter_model(
        {
            'messages': [
                ToolMessage(
                    content='Tool error: hello.py does not exist in the workspace.',
                    tool_call_id='tool-1',
                    name='plan_and_modify',
                ),
                AIMessage(
                    content='',
                    tool_calls=[{'name': 'plan_and_modify', 'args': {'task_summary': 'retry'}, 'id': 'tool-2'}],
                ),
            ],
            'empty_response_nudge_streak': 0,
            'post_tool_silent_tool_streak': 0,
        },
        MagicMock(),
    )

    assert result == {'post_tool_silent_tool_streak': 1, 'empty_response_nudge_streak': 0}


async def test_post_tool_silent_streak_second_turn_nudges_repeat_modify() -> None:
    middleware = EmptyResponseNudgeMiddleware()

    result = await middleware.aafter_model(
        {
            'messages': [
                ToolMessage(
                    content='Tool error: hello.py does not exist in the workspace.',
                    tool_call_id='tool-1',
                    name='plan_and_modify',
                ),
                AIMessage(
                    content='',
                    tool_calls=[{'name': 'plan_and_modify', 'args': {'task_summary': 'retry'}, 'id': 'tool-2'}],
                ),
            ],
            'empty_response_nudge_streak': 0,
            'post_tool_silent_tool_streak': 1,
        },
        MagicMock(),
    )

    assert result is not None
    assert result['jump_to'] == 'model'
    assert result['post_tool_silent_tool_streak'] == 0
    assert result['empty_response_nudge_streak'] == 0
    assert 'Stop repeating' in result['messages'][0].content


async def test_list_tool_result_then_read_tool_only_does_not_trigger_modify_spam_nudge() -> None:
    """Regression: list → read → modify is normal; latest tool is not plan_and_modify yet."""
    middleware = EmptyResponseNudgeMiddleware()

    result = await middleware.aafter_model(
        {
            'messages': [
                ToolMessage(
                    content='Directory: .\nhello.py',
                    tool_call_id='tool-1',
                    name='list_workspace_directory',
                ),
                AIMessage(
                    content='',
                    tool_calls=[
                        {'name': 'read_workspace_file', 'args': {'relative_path': 'hello.py'}, 'id': 'tool-2'}
                    ],
                ),
            ],
            'empty_response_nudge_streak': 0,
            'post_tool_silent_tool_streak': 99,
        },
        MagicMock(),
    )

    assert result == {'post_tool_silent_tool_streak': 0, 'empty_response_nudge_streak': 0}


async def test_after_failed_modify_read_workspace_resets_spam_streak() -> None:
    middleware = EmptyResponseNudgeMiddleware()

    result = await middleware.aafter_model(
        {
            'messages': [
                ToolMessage(
                    content='Tool error: nested planning failed.',
                    tool_call_id='tool-1',
                    name='plan_and_modify',
                ),
                AIMessage(
                    content='',
                    tool_calls=[
                        {'name': 'read_workspace_file', 'args': {'relative_path': 'hello.py'}, 'id': 'tool-2'}
                    ],
                ),
            ],
            'empty_response_nudge_streak': 0,
            'post_tool_silent_tool_streak': 2,
        },
        MagicMock(),
    )

    assert result == {'post_tool_silent_tool_streak': 0, 'empty_response_nudge_streak': 0}


async def test_empty_response_nudge_keeps_generic_tool_result_prompt_for_other_tools() -> None:
    middleware = EmptyResponseNudgeMiddleware()

    result = await middleware.aafter_model(
        {
            'messages': [
                ToolMessage(
                    content='Directory: .\nfile.py',
                    tool_call_id='tool-1',
                    name='list_workspace_directory',
                ),
                AIMessage(content=''),
            ],
            'empty_response_nudge_streak': 0,
        },
        MagicMock(),
    )

    assert result is not None
    assert 'You already have tool results' in result['messages'][0].content
