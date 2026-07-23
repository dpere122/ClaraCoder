"""Tests for chat-attached image vision injection."""

from __future__ import annotations

import base64
from io import BytesIO

import pytest
from PIL import Image

from nemo_backend.chat_attachment_vision import (
    ATTACHED_IMAGE_PREFIX,
    attached_image_path_from_text,
    attached_image_paths_from_text,
    prepare_chat_attachment_vision_turn,
)
from nemo_backend.state import current_session_id, get_session
from nemo_backend.tools.workspace_image import vision_payload_from_data_url


def _png_data_url(*, color: tuple[int, int, int] = (0, 128, 255)) -> str:
    buf = BytesIO()
    Image.new('RGB', (16, 12), color=color).save(buf, format='PNG')
    encoded = base64.standard_b64encode(buf.getvalue()).decode('ascii')
    return f'data:image/png;base64,{encoded}'


def _write_png(path, *, color: tuple[int, int, int] = (255, 0, 0)) -> None:
    im = Image.new('RGB', (32, 24), color=color)
    im.save(path, format='PNG')


@pytest.fixture
def workspace_session(tmp_path):
    session_id = 'chat-attach-vision'
    token = current_session_id.set(session_id)
    root = tmp_path / 'ws'
    root.mkdir()
    session = get_session(session_id)
    session.workspace_path = str(root.resolve())
    try:
        yield root
    finally:
        current_session_id.reset(token)


def test_attached_image_path_from_text() -> None:
    text = (
        f'{ATTACHED_IMAGE_PREFIX}assets/ui.png '
        '(use read_workspace_image with relative_path="assets/ui.png" for visual analysis)'
    )
    assert attached_image_path_from_text(text) == 'assets/ui.png'


def test_attached_image_path_from_text_after_session_preamble() -> None:
    text = (
        '**Session truth (authoritative for this message):**\n'
        f'{ATTACHED_IMAGE_PREFIX}assets/ui.png '
        '(use read_workspace_image with relative_path="assets/ui.png" for visual analysis)'
    )
    assert attached_image_path_from_text(text) == 'assets/ui.png'
    assert attached_image_paths_from_text(text) == ['assets/ui.png']


def test_vision_payload_from_data_url() -> None:
    url = _png_data_url()
    payload = vision_payload_from_data_url(url, relative_path='assets/ui.png')
    assert payload is not None
    assert payload.relative_path == 'assets/ui.png'
    assert payload.width == 16
    assert payload.height == 12
    assert payload.data_url == url


def test_prepare_chat_attachment_vision_turn_loads_workspace_paths(workspace_session) -> None:
    img_path = workspace_session / 'mockup.png'
    _write_png(img_path)
    hint = (
        f'{ATTACHED_IMAGE_PREFIX}mockup.png '
        '(use read_workspace_image with relative_path="mockup.png" for visual analysis)'
    )
    user_blocks = [
        {'type': 'text', 'text': 'What is in this screenshot?'},
        {'type': 'text', 'text': hint},
    ]

    model_blocks = prepare_chat_attachment_vision_turn(user_blocks)

    assert isinstance(model_blocks, list)
    assert len(model_blocks) == 4
    assert model_blocks[0]['type'] == 'text'
    assert model_blocks[1]['type'] == 'text'
    assert model_blocks[2]['type'] == 'text'
    assert 'chat attachment' in str(model_blocks[2]['text'])
    assert 'mockup.png' in str(model_blocks[2]['text'])
    assert model_blocks[3]['type'] == 'image_url'
    assert str(model_blocks[3]['image_url']['url']).startswith('data:image/png;base64,')


def test_prepare_chat_attachment_vision_turn_image_only_with_preamble(workspace_session) -> None:
    img_path = workspace_session / 'solo.png'
    _write_png(img_path)
    hint = (
        '**Session truth (authoritative for this message):**\n'
        f'{ATTACHED_IMAGE_PREFIX}solo.png '
        '(use read_workspace_image with relative_path="solo.png" for visual analysis)'
    )
    user_blocks = [{'type': 'text', 'text': hint}]

    model_blocks = prepare_chat_attachment_vision_turn(user_blocks)

    assert isinstance(model_blocks, list)
    assert len(model_blocks) == 3
    assert 'chat attachment' in str(model_blocks[1]['text'])
    assert model_blocks[2]['type'] == 'image_url'


def test_prepare_chat_attachment_vision_turn_plain_string_is_unchanged() -> None:
    out = prepare_chat_attachment_vision_turn('hello')
    assert out == 'hello'
