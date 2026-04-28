"""Strip Gemma / LM Studio markers and pseudo tool-call XML from user-visible assistant text."""

from __future__ import annotations

import re
from collections import Counter
from typing import TYPE_CHECKING

# ASCII ``?``, Unicode replacement, fullwidth question mark (common tokenizer / redaction junk).
_PLACEHOLDER_CHARS = frozenset('?\uFFFD\uFF1F')
# Single-character "walls" models sometimes stream into thinking / side channels (not real prose).
_DOMINANT_FILLER_CHARS = frozenset('/.-_#=*+`~|\\')
# Per-chunk reasoning filter: any length, only these + whitespace (models stream ``/`` one token at a time).
_REASONING_CHUNK_FILLER_UNION = _PLACEHOLDER_CHARS | _DOMINANT_FILLER_CHARS

from nemo_backend.model_tuning import is_gemma_family, optimization_preset

if TYPE_CHECKING:
    from nemo_backend.domain import RuntimeConnection

# ``<|channel|>``, ``<|channel>``, etc. — first ``>`` ends the tag (LM Studio / Gemma chat templates).
_GEMMA_PIPE_TAG_RE = re.compile(r'<\|[^>\r\n]+>')
_TURN_TOKEN_RE = re.compile(r'<turn\|>')
_OPEN_FENCE_RE = re.compile(r"^\s{0,3}(`{3,}|~{3,})")
_EXCESSIVE_BLANK_RE = re.compile(r"(?:\n){4,}")
_PSEUDO_TOOL_CALL_BLOCK_RE = re.compile(r'<tool_call\b[\s\S]*?</tool_call>', re.IGNORECASE)
_PSEUDO_TOOL_CALL_OPEN_RE = re.compile(r'<tool_call\b[^>]*/>', re.IGNORECASE)
_LEADING_THINKING_HEADING_RE = re.compile(r'^(?:\r?\n|\s)*思考过程[:：]\s*(?:\r?\n)+', re.UNICODE)
_SELF_CORRECTION_PAREN_RE = re.compile(r'\(Self-Correction:[^)]*\)', re.IGNORECASE)


def gemma_template_sanitize_active_connection(connection: RuntimeConnection | None) -> bool:
    if connection is None:
        return False
    if optimization_preset(connection) == 'gemma':
        return True
    return is_gemma_family(connection.model)


def strip_llm_control_markers(text: str) -> str:
    """Remove ``<|...|>`` and ``<turn|>`` outside Markdown-style fenced blocks (``` / ~~~)."""
    normalized = text.replace('\r\n', '\n').replace('\r', '\n')
    lines = normalized.split('\n')
    in_fence = False
    out: list[str] = []
    for line in lines:
        if in_fence:
            if _OPEN_FENCE_RE.match(line):
                in_fence = False
            out.append(line)
            continue
        if _OPEN_FENCE_RE.match(line):
            in_fence = True
            out.append(line)
            continue
        processed = line
        prev: str | None = None
        while prev != processed:
            prev = processed
            processed = _GEMMA_PIPE_TAG_RE.sub('', processed)
        processed = _TURN_TOKEN_RE.sub('', processed)
        out.append(processed)
    return '\n'.join(out)


def scrub_gemma_pipe_tags_fragment(delta: str) -> str:
    """Strip Gemma ``<|…>`` tags from one streamed chunk (handles whole tags in a single delta)."""
    s = delta
    prev: str | None = None
    while prev != s:
        prev = s
        s = _GEMMA_PIPE_TAG_RE.sub('', s)
    return s


def strip_pseudo_tool_call_xml(text: str) -> str:
    """Remove ``<tool_call>...</tool_call>`` and self-closing variants leaked into ``content``."""
    s = text
    prev: str | None = None
    while prev != s:
        prev = s
        s = _PSEUDO_TOOL_CALL_BLOCK_RE.sub('', s)
    s = _PSEUDO_TOOL_CALL_OPEN_RE.sub('', s)
    return s


def strip_assistant_channel_noise(text: str) -> str:
    """Control markers, ``<turn|>``, pseudo tool-call XML, and common thinking-dump prefixes."""
    t = strip_llm_control_markers(strip_pseudo_tool_call_xml(text))
    t = _LEADING_THINKING_HEADING_RE.sub('', t, count=1)
    t = _SELF_CORRECTION_PAREN_RE.sub('', t)
    return t


def collapse_excessive_assistant_blank_lines(text: str) -> str:
    return _EXCESSIVE_BLANK_RE.sub('\n\n\n', text)


def sanitize_gemma_visible_assistant_text(text: str) -> str:
    return collapse_excessive_assistant_blank_lines(strip_assistant_channel_noise(text))


def maybe_sanitize_gemma_visible_assistant_text(text: str, *, connection: RuntimeConnection | None) -> str:
    t = strip_assistant_channel_noise(text)
    if not gemma_template_sanitize_active_connection(connection):
        return t
    return collapse_excessive_assistant_blank_lines(t)


def _collapsed_non_whitespace(text: str) -> str:
    t = (text or '').replace('\r\n', '\n').replace('\r', '\n')
    return ''.join(t.split())


def _dominant_filler_noise(t: str, *, min_chars: int, min_ratio: float) -> bool:
    """True when one repeated filler character accounts for most of *t* (whitespace already removed)."""
    if len(t) < min_chars:
        return False
    _ch, count = Counter(t).most_common(1)[0]
    if count / len(t) < min_ratio:
        return False
    return _ch in _DOMINANT_FILLER_CHARS


def is_placeholder_thinking_noise(text: str, *, min_chars: int = 32, min_ratio: float = 0.88) -> bool:
    """True when *text* is mostly unknown-token / redaction placeholders (``?``, U+FFFD, U+FF1F).

    Also treats long runs of a single filler punctuation character (e.g. ``/``, ``.``, ``-``) as
    noise—models sometimes stream these into ``reasoning_content`` with no real thinking text.

    Some OpenAI-compatible stacks stream ``reasoning_content`` or ``content`` filled with
    placeholders when the local tokenizer cannot decode a thinking channel, which otherwise
    floods the UI and agent history.
    """
    t = _collapsed_non_whitespace(text)
    if len(t) < min_chars:
        return False
    bad = sum(1 for c in t if c in _PLACEHOLDER_CHARS)
    if (bad / len(t)) >= min_ratio:
        return True
    return _dominant_filler_noise(t, min_chars=min_chars, min_ratio=min_ratio)


def is_auxiliary_reasoning_placeholder_delta(delta: str) -> bool:
    """True when a *reasoning* chunk is only placeholder / filler punctuation (any length).

    Thinking channels are often streamed **one character per delta** (e.g. ``/`` walls). The main
    ``content`` path keeps :func:`is_placeholder_stream_delta` stricter so ``foo`` + ``/`` + ``bar``
    in the visible answer is not eaten across chunks.
    """
    stripped = (delta or '').strip()
    if not stripped:
        return False
    if is_placeholder_thinking_noise(delta):
        return True
    collapsed = ''.join(stripped.split())
    if not collapsed:
        return False
    return all(c in _REASONING_CHUNK_FILLER_UNION or c.isspace() for c in stripped)


def is_placeholder_stream_delta(delta: str, *, min_len: int = 8) -> bool:
    """True when a single streamed *main content* chunk is placeholder / filler noise."""
    stripped = (delta or '').strip()
    if not stripped:
        return False
    collapsed = ''.join(stripped.split())
    if len(set(collapsed)) == 1 and collapsed[0] in _DOMINANT_FILLER_CHARS and len(collapsed) >= min_len:
        return True
    if all(c in _PLACEHOLDER_CHARS or c.isspace() for c in stripped) and len(collapsed) >= min_len:
        return True
    return False
