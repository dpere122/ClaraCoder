"""Inject workspace images into the model turn after ``read_workspace_image``."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import AIMessage, AnyMessage, HumanMessage, ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

from clara_coder_backend.llm.messages import stringify_content
from clara_coder_backend.tools.workspace_image import (
    READ_WORKSPACE_IMAGE_NAME,
    VisionImagePayload,
    load_workspace_image,
)


def vision_human_content_for_payload(
    payload: VisionImagePayload,
    *,
    source: str = READ_WORKSPACE_IMAGE_NAME,
) -> list[dict[str, object]]:
    focus_line = f'\nFocus: {payload.focus}' if payload.focus else ''
    text = (
        f'Vision input from `{source}`: `{payload.relative_path}` '
        f'({payload.mime_type}, {payload.width}x{payload.height} px). '
        'Describe and analyze this image for the user\'s task.'
        f'{focus_line}'
    )
    return [
        {'type': 'text', 'text': text},
        {'type': 'image_url', 'image_url': {'url': payload.data_url}},
    ]


def _vision_human_content(payload: VisionImagePayload) -> list[dict[str, object]]:
    return vision_human_content_for_payload(payload, source=READ_WORKSPACE_IMAGE_NAME)


def _tool_message_from_result(
    result: ToolMessage | Command | object,
    request: ToolCallRequest,
    name: str,
) -> ToolMessage:
    if isinstance(result, ToolMessage):
        # Drop artifact once the image is injected as a HumanMessage so checkpoints
        # do not retain a second copy of the base64 payload.
        if getattr(result, 'artifact', None) is not None:
            return ToolMessage(
                content=result.content,
                tool_call_id=str(getattr(result, 'tool_call_id', '') or ''),
                name=str(getattr(result, 'name', '') or '') or name,
                status=getattr(result, 'status', 'success'),
            )
        return result
    return ToolMessage(
        content=stringify_content(result),
        tool_call_id=str(request.tool_call.get('id') or ''),
        name=name,
    )


def _payload_from_tool_result(result: ToolMessage | Command | object) -> VisionImagePayload | None:
    """Read the vision payload carried on the ToolMessage artifact (survives thread handoff)."""
    if isinstance(result, ToolMessage):
        art = getattr(result, 'artifact', None)
        if isinstance(art, VisionImagePayload):
            return art
    return None


def _payload_from_tool_args(
    request: ToolCallRequest,
    result: ToolMessage | Command | object,
) -> VisionImagePayload | None:
    """Fallback: reload the image when the tool reported success but artifact is missing."""
    tm = _tool_message_from_result(result, request, READ_WORKSPACE_IMAGE_NAME)
    text = stringify_content(tm.content)
    if 'Loaded image:' not in text:
        return None
    args = request.tool_call.get('args') if isinstance(request.tool_call, dict) else None
    if not isinstance(args, dict):
        return None
    rel = str(args.get('relative_path') or '').strip()
    if not rel:
        return None
    focus = str(args.get('focus') or '')
    _summary, payload = load_workspace_image(rel, focus=focus)
    return payload


def tool_responses_before_interjections(messages: list[AnyMessage]) -> list[AnyMessage]:
    """Move each batch's ToolMessages ahead of HumanMessages that landed between them.

    Every tool call's result lands in tool-call order, so a parallel batch with an image read
    yields ``tool, vision human, tool``. Providers (Moonshot, OpenAI) require all of an
    assistant message's tool responses to follow it directly and reject the rest as unanswered.
    """
    out: list[AnyMessage] = []
    i = 0
    while i < len(messages):
        msg = messages[i]
        out.append(msg)
        i += 1
        if not isinstance(msg, AIMessage):
            continue
        pending = {str(tc.get('id') or '') for tc in msg.tool_calls or []}
        if not pending:
            continue
        responses: list[AnyMessage] = []
        interjections: list[AnyMessage] = []
        while i < len(messages) and pending and isinstance(messages[i], (ToolMessage, HumanMessage)):
            nxt = messages[i]
            if isinstance(nxt, ToolMessage):
                responses.append(nxt)
                pending.discard(str(nxt.tool_call_id or ''))
            else:
                interjections.append(nxt)
            i += 1
        out.extend(responses)
        out.extend(interjections)
    return out


class VisionImageInjectionMiddleware(AgentMiddleware):
    """After ``read_workspace_image``, append a multimodal HumanMessage with the loaded image.

    Sync ``@tool`` functions run via ``run_in_executor``, so a ContextVar set inside the tool
    is not visible here. The tool returns ``(summary, VisionImagePayload)`` as a ToolMessage
    artifact; we read that (or reload from args) and inject the image into the next model turn.
    Before each model call the batch is reordered so the images follow every tool response
    (this also repairs checkpoints saved with the interleaved order).
    """

    async def awrap_model_call(
        self,
        request: Any,
        handler: Callable[[Any], Awaitable[Any]],
    ) -> Any:
        messages = list(request.messages)
        ordered = tool_responses_before_interjections(messages)
        if all(a is b for a, b in zip(ordered, messages)):
            return await handler(request)
        return await handler(request.override(messages=ordered))

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        result = await handler(request)
        name = str(request.tool_call.get('name') or '')
        if name != READ_WORKSPACE_IMAGE_NAME:
            return result

        payload = _payload_from_tool_result(result)
        if payload is None:
            payload = _payload_from_tool_args(request, result)
        if payload is None:
            return result

        tm = _tool_message_from_result(result, request, name)
        vision_msg = HumanMessage(content=_vision_human_content(payload))
        return Command(update={'messages': [tm, vision_msg]})
