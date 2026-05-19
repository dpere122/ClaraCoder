from __future__ import annotations

from unittest.mock import MagicMock, patch

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

    assert result == {
        'empty_response_nudge_streak': 0,
        'pseudo_tool_markup_nudge_streak': 0,
    }


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


_PSEUDO_XML = (
    '<tool_call><function=list_workspace_directory>'
    '<parameter name="relative_path">server</parameter></function></tool_call>'
)


async def test_pseudo_tool_markup_in_text_nudges_without_api_tool_calls() -> None:
    """Qwen / template stacks often emit <tool_call> in content or reasoning, not in tool_calls."""
    middleware = EmptyResponseNudgeMiddleware()
    result = await middleware.aafter_model(
        {
            'messages': [
                AIMessage(content=_PSEUDO_XML),
            ],
            'empty_response_nudge_streak': 0,
        },
        MagicMock(),
    )
    assert result is not None
    assert result.get('jump_to') == 'model'
    assert result.get('pseudo_tool_markup_nudge_streak') == 1
    assert 'tool-calling' in (result.get('messages') or [{}])[0].content
    assert result.get('empty_response_nudge_streak') == 0


@patch('nemo_backend.empty_response_middleware.MAX_AGENT_PSEUDO_TOOL_NUDGES', 2)
async def test_pseudo_tool_markup_nudge_stops_at_cap() -> None:
    middleware = EmptyResponseNudgeMiddleware()
    result = await middleware.aafter_model(
        {
            'messages': [AIMessage(content=_PSEUDO_XML)],
            'pseudo_tool_markup_nudge_streak': 2,
        },
        MagicMock(),
    )
    assert result is None


async def test_prose_only_resets_pseudo_streak() -> None:
    middleware = EmptyResponseNudgeMiddleware()
    result = await middleware.aafter_model(
        {
            'messages': [AIMessage(content='Here is a normal answer for the user.')],
            'pseudo_tool_markup_nudge_streak': 3,
        },
        MagicMock(),
    )
    assert result == {
        'empty_response_nudge_streak': 0,
        'pseudo_tool_markup_nudge_streak': 0,
    }
