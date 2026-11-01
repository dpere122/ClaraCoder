"""HTTP route: suggest a short conversation title from in-memory session history."""

from __future__ import annotations

import logging
import re
from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from langchain_core.messages import HumanMessage, SystemMessage

from clara_coder_backend.llm.factory import build_llm
from clara_coder_backend.llm.gemma_output import gemma_content_needs_parsing, split_gemma_channels
from clara_coder_backend.llm.messages import stringify_content
from clara_coder_backend.session.schemas import SuggestConversationTitleRequest
from clara_coder_backend.session.state import get_session
from clara_coder_backend.tools.workspace import truncate_text

logger = logging.getLogger('clara.title')

router = APIRouter()

_PER_TURN_CHAR_LIMIT = 800
_MAX_TRANSCRIPT_CHARS = 12_000

_TITLE_SYSTEM = (
    'You output a single very short title for a chat thread. '
    'Rules: maximum 8 words; no quotation marks; no newlines; '
    'concise topic label. Output only the title text, nothing else. '
    'Do not reason aloud or emit special tokens.'
)

_THINK_BLOCK_RE = re.compile(r'<think>.*?</think>', re.DOTALL | re.IGNORECASE)
_CONTROL_LINE_RE = re.compile(r'^(?:<\|\S+|<(?:channel|think)\b)', re.IGNORECASE)


def sanitize_suggested_title(raw: Any) -> str:
    """Take the first visible title line; drop thinking channels and control tokens."""
    text = stringify_content(raw)
    if gemma_content_needs_parsing(text):
        text, _ = split_gemma_channels(text)
    text = _THINK_BLOCK_RE.sub('', text)
    first = ''
    for line in (text.strip().splitlines() if text.strip() else []):
        candidate = line.strip()
        if not candidate or _CONTROL_LINE_RE.match(candidate):
            continue
        first = candidate
        break
    first = re.sub(r'^["\'\[\(]+|["\'\]\)]+$', '', first.strip())
    safe = ' '.join(first.split())[:120]
    if not safe or safe.startswith('<|') or safe.startswith('<channel'):
        return ''
    return safe


def history_transcript_for_title(history: list[dict[str, Any]]) -> str:
    """Flatten recent user/assistant turns into a bounded plain-text block."""
    lines: list[str] = []
    total = 0
    for item in history:
        role = str(item.get('role') or '')
        if role not in ('user', 'assistant'):
            continue
        body = truncate_text(stringify_content(item.get('content', '')), _PER_TURN_CHAR_LIMIT)
        if not body.strip():
            continue
        prefix = 'User' if role == 'user' else 'Assistant'
        chunk = f'{prefix}: {body}'
        if total + len(chunk) + 1 > _MAX_TRANSCRIPT_CHARS:
            break
        lines.append(chunk)
        total += len(chunk) + 1
    return '\n'.join(lines)


@router.post('/conversation/suggest-title')
async def suggest_conversation_title(request: SuggestConversationTitleRequest) -> JSONResponse:
    session = get_session(request.session_id)
    transcript = history_transcript_for_title(session.history)
    if not transcript.strip():
        return JSONResponse({'title': ''})

    try:
        llm = build_llm(disable_thinking=True)
    except Exception as exc:
        logger.warning('suggest-title: build_llm failed: %s', exc)
        return JSONResponse({'title': ''})

    human = f'Conversation excerpt:\n\n{transcript}'
    try:
        resp = await llm.ainvoke(
            [SystemMessage(content=_TITLE_SYSTEM), HumanMessage(content=human)],
        )
    except Exception as exc:
        logger.warning('suggest-title: ainvoke failed: %s', exc)
        return JSONResponse({'title': ''})

    # Claude returns a list of content blocks; sanitize_suggested_title flattens it.
    safe = sanitize_suggested_title(getattr(resp, 'content', '') or '')
    if not safe:
        return JSONResponse({'title': ''})
    return JSONResponse({'title': safe})
