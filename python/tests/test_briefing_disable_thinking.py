"""Tests for disabling thinking on Clara's first-turn briefing model call."""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from clara_coder_backend.middleware.briefing_disable_thinking_middleware import (
    ClaraBriefingDisableThinkingMiddleware,
    is_clara_briefing_model_call,
)


def test_is_briefing_when_no_tools_after_last_human() -> None:
    assert is_clara_briefing_model_call([HumanMessage(content='sort a list')]) is True
    assert is_clara_briefing_model_call(
        [
            HumanMessage(content='old'),
            AIMessage(content='done', tool_calls=[{'name': 'search_workspace', 'id': '1', 'args': {}}]),
            ToolMessage(content='hits', tool_call_id='1'),
            HumanMessage(content='now fix the bug'),
        ]
    ) is True


def test_is_not_briefing_after_tools_this_turn() -> None:
    assert is_clara_briefing_model_call(
        [
            HumanMessage(content='fix the bug'),
            AIMessage(content='looking', tool_calls=[{'name': 'search_workspace', 'id': '1', 'args': {}}]),
            ToolMessage(content='hits', tool_call_id='1'),
        ]
    ) is False


class _Req:
    def __init__(self, messages: list[Any]) -> None:
        self.messages = messages
        self.model = 'orig'
        self.overrides: list[dict[str, Any]] = []

    def override(self, **kwargs: Any) -> _Req:
        self.overrides.append(kwargs)
        nxt = _Req(self.messages)
        nxt.model = kwargs.get('model', self.model)
        nxt.overrides = self.overrides
        return nxt


@patch('clara_coder_backend.middleware.briefing_disable_thinking_middleware.build_llm')
def test_middleware_disables_thinking_on_first_briefing_call(mock_build: MagicMock) -> None:
    mock_build.return_value = 'no-think-llm'
    mw = ClaraBriefingDisableThinkingMiddleware()
    req = _Req([HumanMessage(content='hello')])
    seen: list[Any] = []

    def _handler(r: Any) -> str:
        seen.append(r)
        return 'ok'

    assert mw.wrap_model_call(req, _handler) == 'ok'
    mock_build.assert_called_once_with(disable_thinking=True)
    assert seen[0].model == 'no-think-llm'

    mock_build.reset_mock()
    later = _Req(
        [
            HumanMessage(content='hello'),
            AIMessage(content='ok', tool_calls=[{'name': 'search_workspace', 'id': '1', 'args': {}}]),
            ToolMessage(content='hits', tool_call_id='1'),
        ]
    )
    assert mw.wrap_model_call(later, _handler) == 'ok'
    mock_build.assert_not_called()
    assert seen[1].model == 'orig'


@patch('clara_coder_backend.middleware.briefing_disable_thinking_middleware.build_llm')
def test_middleware_skips_resume_mid_tools(mock_build: MagicMock) -> None:
    mw = ClaraBriefingDisableThinkingMiddleware()
    req = _Req(
        [
            HumanMessage(content='hello'),
            ToolMessage(content='hits', tool_call_id='1'),
        ]
    )
    seen: list[Any] = []

    def _handler(r: Any) -> str:
        seen.append(r)
        return 'ok'

    mw.wrap_model_call(req, _handler)
    mock_build.assert_not_called()
    assert seen[0].model == 'orig'
