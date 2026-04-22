"""Tests for LLM coaching copy and LangGraph coaching middleware."""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

from nemo_backend.config import MAX_INVALID_TOOL_CALL_COACH_NUDGES
from nemo_backend.domain import SessionState
from nemo_backend.invalid_tool_call_coach_middleware import InvalidToolCallCoachMiddleware
from nemo_backend.llm_coaching import SYSTEM_COACHING_MARKER, tool_error_coaching_suffix
from nemo_backend.messages import build_system_prompt
from nemo_backend.tool_outcome_coach_middleware import ToolOutcomeCoachMiddleware


def test_build_system_prompt_includes_coaching_marker() -> None:
    s = SessionState()
    text = build_system_prompt(s, apply_mode=False)
    assert SYSTEM_COACHING_MARKER in text


@pytest.mark.asyncio(loop_scope='function')
class TestInvalidToolCallCoachMiddleware:
    async def test_nudges_with_jump_to_model(self) -> None:
        mw = InvalidToolCallCoachMiddleware()
        state: dict[str, Any] = {
            'messages': [
                AIMessage(
                    content='',
                    tool_calls=[],
                    invalid_tool_calls=[{'name': 'bad_tool', 'args': 'not-json', 'error': 'JSON decode error'}],
                )
            ],
            'invalid_tool_call_coach_streak': 0,
        }
        out = await mw.aafter_model(state, MagicMock())  # type: ignore[arg-type]
        assert out is not None
        assert out.get('jump_to') == 'model'
        msgs = out.get('messages') or []
        assert len(msgs) == 1
        assert isinstance(msgs[0], HumanMessage)
        body = str(msgs[0].content)
        assert 'malformed' in body.lower() or 'rejected' in body.lower()
        assert 'bad_tool' in body
        assert out.get('invalid_tool_call_coach_streak') == 1

    async def test_resets_streak_when_no_invalid_calls(self) -> None:
        mw = InvalidToolCallCoachMiddleware()
        state: dict[str, Any] = {
            'messages': [AIMessage(content='hi', tool_calls=[])],
            'invalid_tool_call_coach_streak': 9,
        }
        out = await mw.aafter_model(state, MagicMock())  # type: ignore[arg-type]
        assert out == {'invalid_tool_call_coach_streak': 0}

    async def test_cap_returns_none(self) -> None:
        mw = InvalidToolCallCoachMiddleware()
        state: dict[str, Any] = {
            'messages': [
                AIMessage(
                    content='',
                    tool_calls=[],
                    invalid_tool_calls=[{'name': 'x'}],
                )
            ],
            'invalid_tool_call_coach_streak': MAX_INVALID_TOOL_CALL_COACH_NUDGES,
        }
        out = await mw.aafter_model(state, MagicMock())  # type: ignore[arg-type]
        assert out is None


@pytest.mark.asyncio(loop_scope='function')
class TestToolOutcomeCoachMiddleware:
    async def test_appends_error_suffix(self) -> None:
        mw = ToolOutcomeCoachMiddleware()
        req = ToolCallRequest(
            tool_call={'name': 'read_workspace_file', 'id': 't1', 'args': {}},
            tool=None,
            state={},
            runtime=None,  # type: ignore[arg-type]
        )

        async def handler(_: ToolCallRequest) -> ToolMessage:
            return ToolMessage(content='Tool error: missing path', tool_call_id='t1', name='read_workspace_file')

        out = await mw.awrap_tool_call(req, handler)
        assert isinstance(out, ToolMessage)
        assert str(out.content).startswith('Tool error:')
        assert tool_error_coaching_suffix().strip() in str(out.content)

    async def test_success_suffix_for_allowlisted_tool(self) -> None:
        mw = ToolOutcomeCoachMiddleware()
        req = ToolCallRequest(
            tool_call={'name': 'modify_workspace', 'id': 't2', 'args': {}},
            tool=None,
            state={},
            runtime=None,  # type: ignore[arg-type]
        )

        async def handler(_: ToolCallRequest) -> ToolMessage:
            return ToolMessage(content='Done.', tool_call_id='t2', name='modify_workspace')

        out = await mw.awrap_tool_call(req, handler)
        assert isinstance(out, ToolMessage)
        assert 'completed successfully' in str(out.content)
        assert 'modify_workspace' in str(out.content)

    async def test_no_success_suffix_for_non_allowlisted(self) -> None:
        mw = ToolOutcomeCoachMiddleware()
        req = ToolCallRequest(
            tool_call={'name': 'read_workspace_file', 'id': 't3', 'args': {}},
            tool=None,
            state={},
            runtime=None,  # type: ignore[arg-type]
        )

        async def handler(_: ToolCallRequest) -> ToolMessage:
            return ToolMessage(content='file contents', tool_call_id='t3', name='read_workspace_file')

        out = await mw.awrap_tool_call(req, handler)
        assert isinstance(out, ToolMessage)
        assert out.content == 'file contents'

    async def test_command_updates_tool_messages(self) -> None:
        mw = ToolOutcomeCoachMiddleware()
        req = ToolCallRequest(
            tool_call={'name': 'modify_workspace', 'id': 't4', 'args': {}},
            tool=None,
            state={},
            runtime=None,  # type: ignore[arg-type]
        )
        tm = ToolMessage(content='ok', tool_call_id='t4', name='modify_workspace')
        note = HumanMessage(content='user note')

        async def handler(_: ToolCallRequest) -> Command:
            return Command(update={'messages': [tm, note]})

        out = await mw.awrap_tool_call(req, handler)
        assert isinstance(out, Command)
        msgs = (out.update or {}).get('messages') or []
        assert len(msgs) == 2
        assert isinstance(msgs[0], ToolMessage)
        assert 'completed successfully' in str(msgs[0].content)
        assert msgs[1] is note
