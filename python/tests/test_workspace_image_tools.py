"""Tests for workspace image loading and vision middleware."""

from __future__ import annotations

from io import BytesIO

import pytest
from langchain_core.messages import HumanMessage, ToolMessage
from langgraph.types import Command
from PIL import Image

from clara_coder_backend.model_tuning import combined_model_prompt_suffix, is_qwen35_vision_model
from clara_coder_backend.state import current_session_id, get_session
from clara_coder_backend.vision_tool_middleware import VisionImageInjectionMiddleware
from clara_coder_backend.tools.workspace_image import (
    READ_WORKSPACE_IMAGE_NAME,
    load_workspace_image,
    pending_vision_image_payload,
    read_workspace_image,
)


def _write_png(path, *, color: tuple[int, int, int] = (255, 0, 0)) -> None:
    im = Image.new('RGB', (32, 24), color=color)
    im.save(path, format='PNG')


@pytest.fixture
def workspace_session(tmp_path):
    session_id = 'vision-test'
    token = current_session_id.set(session_id)
    root = tmp_path / 'ws'
    root.mkdir()
    session = get_session(session_id)
    session.workspace_path = str(root.resolve())
    try:
        yield root
    finally:
        current_session_id.reset(token)
        pending_vision_image_payload.set(None)


def test_is_qwen35_vision_model() -> None:
    assert is_qwen35_vision_model('qwen3.5-27b')
    assert is_qwen35_vision_model('Qwen/Qwen3.5-27B-Instruct')
    assert is_qwen35_vision_model('qwen3-5-27b')
    assert not is_qwen35_vision_model('qwen2.5-7b')
    assert not is_qwen35_vision_model('gemma-3-27b')


def test_load_workspace_image_success(workspace_session) -> None:
    img_path = workspace_session / 'assets' / 'shot.png'
    img_path.parent.mkdir()
    _write_png(img_path)

    summary, payload = load_workspace_image('assets/shot.png', focus='header layout')
    assert payload is not None
    assert payload.relative_path == 'assets/shot.png'
    assert payload.width == 32
    assert payload.height == 24
    assert payload.data_url.startswith('data:image/png;base64,')
    assert 'Loaded image: assets/shot.png' in summary
    assert 'Focus: header layout' in summary


def test_load_workspace_image_missing_returns_guidance(workspace_session) -> None:
    summary, payload = load_workspace_image('missing.png')
    assert payload is None
    assert 'not on the workspace disk' in summary


def test_load_workspace_image_rejects_non_image(workspace_session) -> None:
    (workspace_session / 'notes.txt').write_text('hello', encoding='utf-8')
    summary, payload = load_workspace_image('notes.txt')
    assert payload is None
    assert 'not a supported image type' in summary


def test_read_workspace_image_sets_pending_payload(workspace_session) -> None:
    _write_png(workspace_session / 'icon.png')
    pending_vision_image_payload.set(None)
    summary, payload = load_workspace_image('icon.png')
    read_workspace_image.invoke({'relative_path': 'icon.png'})
    assert 'Loaded image: icon.png' in summary
    assert payload is not None
    assert payload.relative_path == 'icon.png'


def test_vision_middleware_injects_multimodal_human_message(workspace_session) -> None:
    import asyncio

    _write_png(workspace_session / 'ui.png')
    pending_vision_image_payload.set(None)

    async def handler(_request):
        summary, payload = load_workspace_image('ui.png')
        pending_vision_image_payload.set(payload)
        return ToolMessage(content=summary, tool_call_id='call-1', name=READ_WORKSPACE_IMAGE_NAME)

    mw = VisionImageInjectionMiddleware()
    req = type('Req', (), {'tool_call': {'name': READ_WORKSPACE_IMAGE_NAME, 'id': 'call-1'}})()

    async def run() -> Command:
        return await mw.awrap_tool_call(req, handler)

    result = asyncio.run(run())

    assert isinstance(result, Command)
    msgs = result.update['messages']
    assert len(msgs) == 2
    assert isinstance(msgs[0], ToolMessage)
    assert isinstance(msgs[1], HumanMessage)
    content = msgs[1].content
    assert isinstance(content, list)
    assert content[0]['type'] == 'text'
    assert content[1]['type'] == 'image_url'
    assert str(content[1]['image_url']['url']).startswith('data:image/png;base64,')


def test_qwen_vision_prompt_suffix_when_preset_and_model_match() -> None:
    from clara_coder_backend.domain import RuntimeConnection

    conn = RuntimeConnection(
        id='q',
        name='q',
        provider='lmstudio',
        base_url='http://127.0.0.1:1234/v1',
        model='qwen3.5-27b',
        parallel_tool_calls=False,
        optimization_preset='qwen',
    )
    suffix = combined_model_prompt_suffix(conn)
    assert 'read_workspace_image' in suffix
