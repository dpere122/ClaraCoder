"""Tests for workspace image loading and vision middleware."""

from __future__ import annotations

import asyncio

import pytest
from langchain_core.messages import HumanMessage, ToolMessage
from langgraph.types import Command
from PIL import Image

from clara_coder_backend.llm.model_tuning import combined_model_prompt_suffix, is_qwen35_vision_model
from clara_coder_backend.middleware.vision_tool_middleware import VisionImageInjectionMiddleware
from clara_coder_backend.session.state import current_session_id, get_session
from clara_coder_backend.tools.workspace_image import (
    READ_WORKSPACE_IMAGE_NAME,
    VisionImagePayload,
    load_workspace_image,
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


def test_read_workspace_image_returns_content_and_artifact(workspace_session) -> None:
    _write_png(workspace_session / 'icon.png')
    # Invoked as a ToolCall so response_format keeps the artifact on ToolMessage.
    out = read_workspace_image.invoke(
        {
            'name': READ_WORKSPACE_IMAGE_NAME,
            'args': {'relative_path': 'icon.png'},
            'id': 'call-img-1',
            'type': 'tool_call',
        }
    )
    assert isinstance(out, ToolMessage)
    assert 'Loaded image: icon.png' in str(out.content)
    assert isinstance(out.artifact, VisionImagePayload)
    assert out.artifact.relative_path == 'icon.png'
    assert out.artifact.data_url.startswith('data:image/png;base64,')


def test_vision_middleware_injects_multimodal_human_message(workspace_session) -> None:
    _write_png(workspace_session / 'ui.png')
    summary, payload = load_workspace_image('ui.png')
    assert payload is not None

    async def handler(_request):
        return ToolMessage(
            content=summary,
            tool_call_id='call-1',
            name=READ_WORKSPACE_IMAGE_NAME,
            artifact=payload,
        )

    mw = VisionImageInjectionMiddleware()
    req = type(
        'Req',
        (),
        {
            'tool_call': {
                'name': READ_WORKSPACE_IMAGE_NAME,
                'id': 'call-1',
                'args': {'relative_path': 'ui.png'},
            }
        },
    )()

    result = asyncio.run(mw.awrap_tool_call(req, handler))

    assert isinstance(result, Command)
    msgs = result.update['messages']
    assert len(msgs) == 2
    assert isinstance(msgs[0], ToolMessage)
    assert getattr(msgs[0], 'artifact', None) is None  # stripped after injection
    assert isinstance(msgs[1], HumanMessage)
    content = msgs[1].content
    assert isinstance(content, list)
    assert content[0]['type'] == 'text'
    assert content[1]['type'] == 'image_url'
    assert str(content[1]['image_url']['url']).startswith('data:image/png;base64,')


def test_vision_middleware_injects_after_threaded_ainvoke(workspace_session) -> None:
    """Regression: sync tools run via run_in_executor; ContextVar handoff used to drop the image."""
    _write_png(workspace_session / 'threaded.png')

    async def handler(_request):
        return await read_workspace_image.ainvoke(
            {
                'name': READ_WORKSPACE_IMAGE_NAME,
                'args': {'relative_path': 'threaded.png'},
                'id': 'call-threaded',
                'type': 'tool_call',
            }
        )

    mw = VisionImageInjectionMiddleware()
    req = type(
        'Req',
        (),
        {
            'tool_call': {
                'name': READ_WORKSPACE_IMAGE_NAME,
                'id': 'call-threaded',
                'args': {'relative_path': 'threaded.png'},
            }
        },
    )()

    result = asyncio.run(mw.awrap_tool_call(req, handler))
    assert isinstance(result, Command)
    vision = result.update['messages'][1]
    assert isinstance(vision, HumanMessage)
    assert isinstance(vision.content, list)
    assert vision.content[1]['type'] == 'image_url'
    assert str(vision.content[1]['image_url']['url']).startswith('data:image/png;base64,')


def test_vision_middleware_reloads_from_args_when_artifact_missing(workspace_session) -> None:
    """Sync tools run in a thread pool; if artifact is lost, args + success text still inject."""
    _write_png(workspace_session / 'fallback.png')
    summary, payload = load_workspace_image('fallback.png')
    assert payload is not None

    async def handler(_request):
        return ToolMessage(
            content=summary,
            tool_call_id='call-2',
            name=READ_WORKSPACE_IMAGE_NAME,
            # No artifact — simulates ContextVar / handoff loss.
        )

    mw = VisionImageInjectionMiddleware()
    req = type(
        'Req',
        (),
        {
            'tool_call': {
                'name': READ_WORKSPACE_IMAGE_NAME,
                'id': 'call-2',
                'args': {'relative_path': 'fallback.png', 'focus': 'icons'},
            }
        },
    )()

    result = asyncio.run(mw.awrap_tool_call(req, handler))
    assert isinstance(result, Command)
    vision = result.update['messages'][1]
    assert isinstance(vision, HumanMessage)
    assert isinstance(vision.content, list)
    assert vision.content[1]['type'] == 'image_url'
    assert 'Focus: icons' in str(vision.content[0]['text'])


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
