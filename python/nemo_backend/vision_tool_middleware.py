"""Inject workspace images into the model turn after ``read_workspace_image``."""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import HumanMessage, ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

from nemo_backend.messages import stringify_content
from nemo_backend.tools.workspace_image import (
    READ_WORKSPACE_IMAGE_NAME,
    VisionImagePayload,
    pending_vision_image_payload,
)


def _vision_human_content(payload: VisionImagePayload) -> list[dict[str, object]]:
    focus_line = f'\nFocus: {payload.focus}' if payload.focus else ''
    text = (
        f'Vision input from `{READ_WORKSPACE_IMAGE_NAME}`: `{payload.relative_path}` '
        f'({payload.mime_type}, {payload.width}x{payload.height} px). '
        'Describe and analyze this image for the user\'s task.'
        f'{focus_line}'
    )
    return [
        {'type': 'text', 'text': text},
        {'type': 'image_url', 'image_url': {'url': payload.data_url}},
    ]


def _tool_message_from_result(
    result: ToolMessage | Command | object,
    request: ToolCallRequest,
    name: str,
) -> ToolMessage:
    if isinstance(result, ToolMessage):
        return result
    return ToolMessage(
        content=stringify_content(result),
        tool_call_id=str(request.tool_call.get('id') or ''),
        name=name,
    )


class VisionImageInjectionMiddleware(AgentMiddleware):
    """After ``read_workspace_image``, append a multimodal HumanMessage with the loaded image."""

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        pending_vision_image_payload.set(None)
        result = await handler(request)
        name = str(request.tool_call.get('name') or '')
        if name != READ_WORKSPACE_IMAGE_NAME:
            return result

        payload = pending_vision_image_payload.get()
        pending_vision_image_payload.set(None)
        if payload is None:
            return result

        tm = _tool_message_from_result(result, request, name)
        vision_msg = HumanMessage(content=_vision_human_content(payload))
        return Command(update={'messages': [tm, vision_msg]})
