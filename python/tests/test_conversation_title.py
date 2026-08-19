"""Tests for auto-title cadence helper and suggest-title HTTP route."""

from __future__ import annotations

from typing import Any

import pytest
from langchain_core.messages import AIMessage
from starlette.testclient import TestClient

from clara_coder_backend.chat.conversation_title_cadence import should_refresh_auto_title
from clara_coder_backend.routes.conversation_title import history_transcript_for_title, sanitize_suggested_title


@pytest.mark.parametrize(
    ('n', 'expected'),
    [
        (0, False),
        (1, True),
        (2, False),
        (24, False),
        (25, True),
        (26, False),
        (50, True),
    ],
)
def test_should_refresh_auto_title(n: int, expected: bool) -> None:
    assert should_refresh_auto_title(n) is expected


def test_history_transcript_for_title_skips_non_chat_roles() -> None:
    h: list[dict[str, Any]] = [
        {'role': 'system', 'content': 'ignored'},
        {'role': 'user', 'content': 'hello'},
        {'role': 'assistant', 'content': 'hi there'},
    ]
    t = history_transcript_for_title(h)
    assert 'User:' in t
    assert 'hello' in t
    assert 'Assistant:' in t
    assert 'ignored' not in t


def test_suggest_title_uses_mock_llm(monkeypatch: pytest.MonkeyPatch) -> None:
    from clara_coder_backend.session import state
    from clara_coder_backend.main import app

    sid = 'title-test-session'
    sess = state.get_session(sid)
    sess.history = [
        {'role': 'user', 'content': 'How do I sort a list in Python?'},
        {'role': 'assistant', 'content': 'Use sorted() or .sort().'},
    ]

    class _FakeLlm:
        async def ainvoke(self, _messages: list[Any]) -> AIMessage:
            return AIMessage(content='Python list sorting')

    captured: dict[str, Any] = {}

    def _fake_build_llm(**kwargs: Any) -> _FakeLlm:
        captured.update(kwargs)
        return _FakeLlm()

    monkeypatch.setattr('clara_coder_backend.routes.conversation_title.build_llm', _fake_build_llm)

    try:
        with TestClient(app) as client:
            r = client.post('/conversation/suggest-title', json={'session_id': sid})
            assert r.status_code == 200
            assert r.json()['title'] == 'Python list sorting'
            assert captured.get('disable_thinking') is True
    finally:
        state.sessions.pop(sid, None)


@pytest.mark.parametrize(
    ('raw', 'expected'),
    [
        ('Python list sorting', 'Python list sorting'),
        ('"<|channel>thought"', ''),
        ('<|channel|>thought', ''),
        ('<|channel>thought', ''),
        ('<|channel>thought\nI am planning\n<channel|>Python list sorting', 'Python list sorting'),
        ('<|channel>thought\nscratchpad only', ''),
        ('<think>plan the name</think>\nFix login bug', 'Fix login bug'),
        ('  "Quoted title"  ', 'Quoted title'),
    ],
)
def test_sanitize_suggested_title(raw: str, expected: str) -> None:
    assert sanitize_suggested_title(raw) == expected


def test_suggest_title_strips_gemma_thought_channel(monkeypatch: pytest.MonkeyPatch) -> None:
    from clara_coder_backend.session import state
    from clara_coder_backend.main import app

    sid = 'title-gemma-session'
    sess = state.get_session(sid)
    sess.history = [
        {'role': 'user', 'content': 'How do I sort a list in Python?'},
        {'role': 'assistant', 'content': 'Use sorted() or .sort().'},
    ]

    class _FakeLlm:
        async def ainvoke(self, _messages: list[Any]) -> AIMessage:
            return AIMessage(content='<|channel>thought\nNaming this\n<channel|>Python list sorting')

    monkeypatch.setattr(
        'clara_coder_backend.routes.conversation_title.build_llm',
        lambda **_kwargs: _FakeLlm(),
    )

    try:
        with TestClient(app) as client:
            r = client.post('/conversation/suggest-title', json={'session_id': sid})
            assert r.status_code == 200
            assert r.json()['title'] == 'Python list sorting'
    finally:
        state.sessions.pop(sid, None)
