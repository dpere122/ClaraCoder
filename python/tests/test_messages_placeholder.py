"""Tests for assistant message text extraction."""

from __future__ import annotations

from langchain_core.messages import AIMessage

from clara_coder_backend.messages import assistant_visible_answer, final_assistant_text


def test_final_assistant_text_keeps_placeholder_reasoning() -> None:
    msg = AIMessage(
        content='',
        additional_kwargs={'reasoning_content': '?' * 50},
    )
    assert final_assistant_text(msg) == '?' * 50


def test_final_assistant_text_keeps_placeholder_main_content() -> None:
    msg = AIMessage(content='?' * 50)
    assert assistant_visible_answer(msg) == '?' * 50
    assert final_assistant_text(msg) == '?' * 50


def test_final_assistant_text_keeps_normal_reasoning_fallback() -> None:
    msg = AIMessage(
        content='',
        additional_kwargs={'reasoning_content': 'Short chain-of-thought then answer.'},
    )
    assert final_assistant_text(msg) == 'Short chain-of-thought then answer.'
