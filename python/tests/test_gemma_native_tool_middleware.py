from __future__ import annotations

import asyncio
from unittest.mock import MagicMock, patch

from langchain_core.messages import AIMessage

from clara_coder_backend.middleware.empty_response_middleware import EmptyResponseNudgeMiddleware
from clara_coder_backend.middleware.gemma_native_tool_middleware import GemmaNativeToolMiddleware


_GOOGLE_TEMPERATURE = '<|tool_call>call:get_current_temperature{location:<|"|>London<|"|>}<tool_call|>'
_ACTIVE = 'clara_coder_backend.middleware.gemma_native_tool_middleware._gemma_native_tools_active'


@patch(_ACTIVE, return_value=True)
def test_gemma_native_middleware_promotes_tool_call(_active: MagicMock) -> None:
    middleware = GemmaNativeToolMiddleware()
    result = asyncio.run(
        middleware.aafter_model(
            {'messages': [AIMessage(content=_GOOGLE_TEMPERATURE)]},
            MagicMock(),
        )
    )
    assert result is not None
    promoted = result['messages'][0]
    assert isinstance(promoted, AIMessage)
    assert promoted.content == ''
    assert promoted.tool_calls
    assert promoted.tool_calls[0]['name'] == 'get_current_temperature'
    assert promoted.tool_calls[0]['args'] == {'location': 'London'}


@patch(_ACTIVE, return_value=True)
def test_gemma_native_middleware_promotes_tool_call_after_thought(_active: MagicMock) -> None:
    middleware = GemmaNativeToolMiddleware()
    raw = (
        "<|channel>thought\nNeed the file.\n<channel|>"
        + _GOOGLE_TEMPERATURE
    )
    result = asyncio.run(
        middleware.aafter_model(
            {'messages': [AIMessage(content=raw)]},
            MagicMock(),
        )
    )
    assert result is not None
    promoted = result['messages'][0]
    assert promoted.tool_calls[0]['name'] == 'get_current_temperature'
    assert promoted.additional_kwargs.get('reasoning_content') == 'Need the file.'
    assert promoted.content == ''


@patch(_ACTIVE, return_value=True)
def test_gemma_native_middleware_promotes_empty_channel_thought_before_tool(_active: MagicMock) -> None:
    middleware = GemmaNativeToolMiddleware()
    raw = (
        '<|channel>thought\n<channel|>Need the file.\n'
        + _GOOGLE_TEMPERATURE
    )
    result = asyncio.run(
        middleware.aafter_model(
            {'messages': [AIMessage(content=raw)]},
            MagicMock(),
        )
    )
    assert result is not None
    promoted = result['messages'][0]
    assert promoted.tool_calls[0]['name'] == 'get_current_temperature'
    assert 'Need the file.' in str(promoted.additional_kwargs.get('reasoning_content') or '')
    assert 'Need the file.' not in str(promoted.content)
    assert promoted.content == ''


@patch(_ACTIVE, return_value=True)
def test_gemma_native_middleware_promotes_from_reasoning_sidecar(_active: MagicMock) -> None:
    middleware = GemmaNativeToolMiddleware()
    msg = AIMessage(content='Visible briefing')
    msg.additional_kwargs['reasoning_content'] = _GOOGLE_TEMPERATURE
    result = asyncio.run(middleware.aafter_model({'messages': [msg]}, MagicMock()))
    assert result is not None
    assert result['messages'][0].tool_calls[0]['name'] == 'get_current_temperature'


@patch(_ACTIVE, return_value=False)
def test_gemma_native_middleware_skips_when_gemma_preset_off(_active: MagicMock) -> None:
    middleware = GemmaNativeToolMiddleware()
    result = asyncio.run(
        middleware.aafter_model(
            {'messages': [AIMessage(content=_GOOGLE_TEMPERATURE)]},
            MagicMock(),
        )
    )
    assert result is None


@patch(_ACTIVE, return_value=True)
def test_gemma_native_middleware_remaps_api_path_aliases(_active: MagicMock) -> None:
    middleware = GemmaNativeToolMiddleware()
    msg = AIMessage(
        content='',
        tool_calls=[
            {
                'name': 'stage_create_file',
                'id': 'api-1',
                'args': {'file_path': 'hello.py', 'content': 'print(1)\n'},
            }
        ],
    )
    result = asyncio.run(middleware.aafter_model({'messages': [msg]}, MagicMock()))
    assert result is not None
    args = result['messages'][0].tool_calls[0]['args']
    assert args == {'relative_path': 'hello.py', 'new_content': 'print(1)\n'}


def test_gemma_native_middleware_ignores_existing_api_tool_calls() -> None:
    middleware = GemmaNativeToolMiddleware()
    msg = AIMessage(
        content=_GOOGLE_TEMPERATURE,
        tool_calls=[{'name': 'search_workspace', 'id': 'api-1', 'args': {'query': 'x'}}],
    )
    result = asyncio.run(middleware.aafter_model({'messages': [msg]}, MagicMock()))
    assert result is None


def test_gemma_native_middleware_ignores_incomplete_markup() -> None:
    middleware = GemmaNativeToolMiddleware()
    incomplete = '<|tool_call>call:read_workspace_file{path:<|"|>a.py<|"|>}'
    result = asyncio.run(
        middleware.aafter_model({'messages': [AIMessage(content=incomplete)]}, MagicMock())
    )
    assert result is None


def test_leftover_gemma_native_markup_triggers_pseudo_tool_nudge() -> None:
    middleware = EmptyResponseNudgeMiddleware()
    leftover = '<|tool_call>call:read_workspace_file{path:<|"|>a.py<|"|>}'
    result = asyncio.run(
        middleware.aafter_model(
            {
                'messages': [AIMessage(content=leftover)],
                'empty_response_nudge_streak': 0,
            },
            MagicMock(),
        )
    )
    assert result is not None
    assert result.get('jump_to') == 'model'
    assert result.get('pseudo_tool_markup_nudge_streak') == 1


@patch('clara_coder_backend.session.state.get_active_connection')
def test_leftover_gemma_native_markup_does_not_nudge_on_gemma_preset(mock_conn: MagicMock) -> None:
    from clara_coder_backend.domain import RuntimeConnection

    mock_conn.return_value = RuntimeConnection(
        id='t',
        name='t',
        provider='lmstudio',
        base_url='http://127.0.0.1:1234/v1',
        model='google/gemma-4-it',
        optimization_preset='gemma',
    )
    middleware = EmptyResponseNudgeMiddleware()
    leftover = '<|tool_call>call:read_workspace_file{path:<|"|>a.py<|"|>}'
    result = asyncio.run(
        middleware.aafter_model(
            {
                'messages': [AIMessage(content=leftover)],
                'empty_response_nudge_streak': 0,
            },
            MagicMock(),
        )
    )
    assert result is None
