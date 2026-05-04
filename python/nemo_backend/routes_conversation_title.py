"""HTTP route: suggest a short conversation title from in-memory session history."""

from __future__ import annotations

import logging
import re
from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from nemo_backend.llm import build_llm
from nemo_backend.messages import stringify_content
from nemo_backend.schemas import SuggestConversationTitleRequest
from nemo_backend.state import get_session
from nemo_backend.workspace_tools import truncate_text

logger = logging.getLogger('nemo.title')

router = APIRouter()

_PER_TURN_CHAR_LIMIT = 800
_MAX_TRANSCRIPT_CHARS = 12_000

_TITLE_SYSTEM = (
    'You output a single very short title for a chat thread. '
    'Rules: maximum 8 words; no quotation marks; no newlines; '
    'concise topic label. Output only the title text, nothing else.'
)


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
        llm = build_llm()
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

    raw = ''
    if isinstance(resp, AIMessage):
        raw = str(resp.content or '')
    else:
        raw = str(getattr(resp, 'content', '') or '')

    stripped = raw.strip()
    raw = stripped.splitlines()[0] if stripped else ''
    raw = re.sub(r'^["\'\[\(]+|["\'\]\)]+$', '', raw.strip())
    safe = ' '.join(raw.split())[:120]
    if not safe:
        return JSONResponse({'title': ''})
    return JSONResponse({'title': safe})
