"""Tests for multimodal / structured chat user turns."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from pydantic import ValidationError

from clara_coder_backend.chat_input import effective_user_message_content, validate_user_turn_not_empty
from clara_coder_backend.schemas import ChatRequest


def test_effective_plain_message_only() -> None:
    assert effective_user_message_content('hello', None) == 'hello'
    assert effective_user_message_content('hello', []) == 'hello'


def test_effective_structured_copies_blocks() -> None:
    out = effective_user_message_content('', [{'type': 'text', 'text': 'x'}])
    assert out == [{'type': 'text', 'text': 'x'}]
    out[0]['text'] = 'mutated'
    assert effective_user_message_content('', [{'type': 'text', 'text': 'x'}])[0]['text'] == 'x'


def test_effective_prepends_message_when_no_text_block() -> None:
    out = effective_user_message_content(
        'Describe this',
        [{'type': 'image_url', 'image_url': {'url': 'https://example.com/a.png'}}],
    )
    assert out[0] == {'type': 'text', 'text': 'Describe this'}
    assert out[1]['type'] == 'image_url'


def test_effective_does_not_duplicate_when_text_block_exists() -> None:
    out = effective_user_message_content(
        'ignored top-level when block has text',
        [{'type': 'text', 'text': 'inner'}],
    )
    assert len(out) == 1
    assert out[0]['text'] == 'inner'


def test_validate_user_turn_not_empty() -> None:
    validate_user_turn_not_empty('ok')
    validate_user_turn_not_empty([{'type': 'text', 'text': 'a'}])
    with pytest.raises(ValueError):
        validate_user_turn_not_empty('')
    with pytest.raises(ValueError):
        validate_user_turn_not_empty('   ')
    with pytest.raises(ValueError):
        validate_user_turn_not_empty([])


def test_chat_request_accepts_message_only() -> None:
    r = ChatRequest(session_id='s', message='hi')
    assert r.structured_content is None


def test_chat_request_accepts_structured_content_snake_case() -> None:
    r = ChatRequest(
        session_id='s',
        structured_content=[{'type': 'text', 'text': 'from json'}],
    )
    assert r.message == ''


def test_chat_request_accepts_structured_content_camel_case() -> None:
    r = ChatRequest.model_validate(
        {
            'session_id': 's',
            'structuredContent': [{'type': 'text', 'text': 'camel'}],
        },
    )
    assert r.structured_content == [{'type': 'text', 'text': 'camel'}]


def test_chat_request_rejects_non_object_structured_entry() -> None:
    with pytest.raises(ValidationError):
        ChatRequest(session_id='s', structured_content=['not-an-object'])  # type: ignore[list-item]


def test_chat_request_rejects_fully_empty_turn() -> None:
    with pytest.raises(ValidationError):
        ChatRequest(session_id='s', message='')


def test_chat_request_rejects_empty_structured_list_only() -> None:
    with pytest.raises(ValidationError):
        ChatRequest(session_id='s', structured_content=[])


@patch('clara_coder_backend.routes.session.delete_outer_threads_for_session', new_callable=AsyncMock)
def test_load_session_accepts_multimodal_user_content(
    _mock_delete: AsyncMock,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv('CLARA_CHECKPOINT_DB', str(tmp_path / 'cp_chat.sqlite'))
    from starlette.testclient import TestClient

    from clara_coder_backend import state
    from clara_coder_backend.main import app

    blocks = [{'type': 'text', 'text': 'hi'}, {'type': 'image_url', 'image_url': {'url': 'x'}}]
    with TestClient(app) as client:
        r = client.post(
            '/load',
            json={'session_id': 'mm', 'messages': [{'role': 'user', 'content': blocks}]},
        )
        assert r.status_code == 200
    sess = state.get_session('mm')
    assert len(sess.history) == 1
    assert sess.history[0]['content'] == blocks
