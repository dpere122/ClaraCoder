from __future__ import annotations

import asyncio
from unittest.mock import MagicMock, patch

import pytest
from langchain_core.messages import AIMessage, ToolMessage

from clara_coder_backend.domain import RuntimeConnection
from clara_coder_backend.middleware.empty_response_middleware import (
    EmptyResponseNudgeMiddleware,
    empty_response_nudge_enabled,
)
from clara_coder_backend.session.state import current_session_id, get_session


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
_UNPARSEABLE_PSEUDO_XML = (
    '<tool_call><function=list_workspace_directory><parameter name="relative_path">'
)


async def test_pseudo_tool_markup_in_text_nudges_without_api_tool_calls() -> None:
    """Unpromotable leftover XML (truncated / unparseable) should re-prompt for API tool calls."""
    middleware = EmptyResponseNudgeMiddleware()
    result = await middleware.aafter_model(
        {
            'messages': [
                AIMessage(content=_UNPARSEABLE_PSEUDO_XML),
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


async def test_parseable_pseudo_tool_markup_does_not_nudge() -> None:
    """Recoverable XML is promoted by PseudoToolXmlMiddleware; do not re-prompt."""
    middleware = EmptyResponseNudgeMiddleware()
    result = await middleware.aafter_model(
        {
            'messages': [AIMessage(content=_PSEUDO_XML)],
            'empty_response_nudge_streak': 0,
        },
        MagicMock(),
    )
    assert result == {
        'empty_response_nudge_streak': 0,
        'pseudo_tool_markup_nudge_streak': 0,
    }


async def test_leftover_gemma_native_markup_nudges_without_api_tool_calls() -> None:
    middleware = EmptyResponseNudgeMiddleware()
    leftover = '<|tool_call>call:read_workspace_file{path:<|"|>a.py<|"|>}'
    result = await middleware.aafter_model(
        {
            'messages': [AIMessage(content=leftover)],
            'empty_response_nudge_streak': 0,
        },
        MagicMock(),
    )
    assert result is not None
    assert result.get('jump_to') == 'model'
    assert result.get('pseudo_tool_markup_nudge_streak') == 1


@patch('clara_coder_backend.middleware.empty_response_middleware.MAX_AGENT_PSEUDO_TOOL_NUDGES', 2)
async def test_pseudo_tool_markup_nudge_stops_at_cap() -> None:
    middleware = EmptyResponseNudgeMiddleware()
    result = await middleware.aafter_model(
        {
            'messages': [AIMessage(content=_UNPARSEABLE_PSEUDO_XML)],
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


def _conn(*, optimization_preset: str) -> RuntimeConnection:
    return RuntimeConnection(
        id='t',
        name='t',
        provider='lmstudio',
        base_url='http://127.0.0.1:1234/v1',
        model='google/gemma-4-it',
        optimization_preset=optimization_preset,
    )


@patch('clara_coder_backend.session.state.get_active_connection')
async def test_empty_response_nudge_disabled_for_gemma_and_qwen_presets(mock_conn: MagicMock) -> None:
    mock_conn.return_value = _conn(optimization_preset='gemma')
    assert empty_response_nudge_enabled() is False
    mock_conn.return_value = _conn(optimization_preset='generic')
    assert empty_response_nudge_enabled() is True
    mock_conn.return_value = _conn(optimization_preset='qwen')
    assert empty_response_nudge_enabled() is False


@patch('clara_coder_backend.session.state.get_active_connection')
async def test_gemma_preset_skips_empty_and_pseudo_tool_nudges(mock_conn: MagicMock) -> None:
    mock_conn.return_value = _conn(optimization_preset='gemma')
    middleware = EmptyResponseNudgeMiddleware()
    empty = await middleware.aafter_model(
        {'messages': [AIMessage(content='')], 'empty_response_nudge_streak': 0},
        MagicMock(),
    )
    leftover = await middleware.aafter_model(
        {
            'messages': [AIMessage(content='<|tool_call>call:read_workspace_file{path:<|"|>a.py<|"|>}')],
            'empty_response_nudge_streak': 0,
        },
        MagicMock(),
    )
    assert empty is None
    assert leftover is None


@patch('clara_coder_backend.session.state.get_active_connection')
async def test_qwen_preset_skips_empty_and_pseudo_tool_nudges(mock_conn: MagicMock) -> None:
    mock_conn.return_value = _conn(optimization_preset='qwen')
    middleware = EmptyResponseNudgeMiddleware()
    empty = await middleware.aafter_model(
        {'messages': [AIMessage(content='')], 'empty_response_nudge_streak': 0},
        MagicMock(),
    )
    leftover = await middleware.aafter_model(
        {
            'messages': [
                AIMessage(
                    content='<tool_call><function=list_workspace_directory><parameter name="relative_path">'
                )
            ],
            'empty_response_nudge_streak': 0,
        },
        MagicMock(),
    )
    assert empty is None
    assert leftover is None
