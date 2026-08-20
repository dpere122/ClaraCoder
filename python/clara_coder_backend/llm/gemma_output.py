"""Parse Gemma 4 interleaved ``<|channel>`` assistant output into visible vs reasoning text.

Mirrors the inverse of Google's ``strip_thinking`` macro in ``chat_template.jinja``
(google/gemma-4-12B-it). Channel interiors route to reasoning; remaining text (including
``<|tool_call>`` blocks) stays in stored content so native calls can be promoted to
LangChain ``tool_calls``. The stream splitter holds complete tool-call blocks off the
live SSE lane.
"""

from __future__ import annotations

import re
from typing import Any

_CHANNEL_BLOCK_RE = re.compile(r'<\|channel>(\w+)\n(.*?)<channel\|>', re.DOTALL)
_CHANNEL_OPEN_RE = re.compile(r'<\|channel>\w+\n')

_CONTROL_TOKENS = (
    '<|turn>model\n',
    '<|turn>user\n',
    '<|turn>system\n',
    '<|think|>\n',
)

_TOOL_CALL_OPEN = '<|tool_call>'
_TOOL_CALL_CLOSE = '<tool_call|>'
_GEMMA_STRING_DELIM = '<|"|>'

# Longest partial prefix we must hold back while streaming (``<|channel>`` / tool tags).
_STREAM_WATCH_TAGS = (
    '<|channel>',
    '<channel|>',
    '<|turn>',
    '<|think|>',
    '<|tool_call>',
    '<tool_call|>',
    '<|tool',
)


class _IncompleteGemmaValue(Exception):
    """Native tool-call argument payload is truncated or malformed."""


def _strip_gemma_control_tokens(text: str) -> str:
    out = text
    for tok in _CONTROL_TOKENS:
        out = out.replace(tok, '')
    return out


def _holdback_suffix_len(text: str) -> int:
    """How many trailing chars might be the start of a control tag."""
    if not text:
        return 0
    max_len = max(len(w) for w in _STREAM_WATCH_TAGS)
    upper = min(len(text), max_len)
    for length in range(upper, 0, -1):
        suffix = text[-length:]
        if any(tag.startswith(suffix) for tag in _STREAM_WATCH_TAGS):
            return length
    return 0


def split_gemma_channels(text: str) -> tuple[str, str]:
    """Split raw assistant content into ``(visible, reasoning)``."""
    if not text:
        return '', ''
    if '<|channel>' not in text and '<channel|>' not in text:
        return _strip_gemma_control_tokens(text).strip(), ''

    reasoning_parts: list[str] = []

    def _collect(match: re.Match[str]) -> str:
        reasoning_parts.append(match.group(2))
        return ''

    visible = _CHANNEL_BLOCK_RE.sub(_collect, text)
    # Unclosed channel (streaming tail): treat remainder as reasoning.
    open_m = _CHANNEL_OPEN_RE.search(visible)
    if open_m:
        reasoning_parts.append(visible[open_m.end() :])
        visible = visible[: open_m.start()]
    visible = _strip_gemma_control_tokens(visible)
    reasoning = ''.join(reasoning_parts)
    return visible.strip(), reasoning.strip()


def gemma_content_needs_parsing(text: str) -> bool:
    return '<|channel>' in text or '<channel|>' in text


def _skip_ws(text: str, i: int) -> int:
    while i < len(text) and text[i] in ' \t\n\r':
        i += 1
    return i


def _atom_end(text: str, i: int) -> bool:
    return i >= len(text) or text[i] in ',}] \t\n\r'


def _parse_gemma_string(text: str, i: int) -> tuple[str, int]:
    if not text.startswith(_GEMMA_STRING_DELIM, i):
        raise _IncompleteGemmaValue
    i += len(_GEMMA_STRING_DELIM)
    end = text.find(_GEMMA_STRING_DELIM, i)
    if end < 0:
        raise _IncompleteGemmaValue
    return text[i:end], end + len(_GEMMA_STRING_DELIM)


def _parse_gemma_mapping(text: str, i: int) -> tuple[dict[str, Any], int]:
    if i >= len(text) or text[i] != '{':
        raise _IncompleteGemmaValue
    i += 1
    out: dict[str, Any] = {}
    i = _skip_ws(text, i)
    if i < len(text) and text[i] == '}':
        return out, i + 1
    while True:
        i = _skip_ws(text, i)
        if i >= len(text):
            raise _IncompleteGemmaValue
        if text.startswith(_GEMMA_STRING_DELIM, i):
            key, i = _parse_gemma_string(text, i)
        else:
            colon = text.find(':', i)
            if colon < 0:
                raise _IncompleteGemmaValue
            key = text[i:colon].strip()
            i = colon
        if not key:
            raise _IncompleteGemmaValue
        i = _skip_ws(text, i)
        if i >= len(text) or text[i] != ':':
            raise _IncompleteGemmaValue
        value, i = _parse_gemma_value(text, i + 1)
        out[key] = value
        i = _skip_ws(text, i)
        if i >= len(text):
            raise _IncompleteGemmaValue
        if text[i] == '}':
            return out, i + 1
        if text[i] != ',':
            raise _IncompleteGemmaValue
        i += 1


def _parse_gemma_array(text: str, i: int) -> tuple[list[Any], int]:
    if i >= len(text) or text[i] != '[':
        raise _IncompleteGemmaValue
    i += 1
    out: list[Any] = []
    i = _skip_ws(text, i)
    if i < len(text) and text[i] == ']':
        return out, i + 1
    while True:
        value, i = _parse_gemma_value(text, i)
        out.append(value)
        i = _skip_ws(text, i)
        if i >= len(text):
            raise _IncompleteGemmaValue
        if text[i] == ']':
            return out, i + 1
        if text[i] != ',':
            raise _IncompleteGemmaValue
        i += 1


def _parse_gemma_value(text: str, i: int) -> tuple[Any, int]:
    i = _skip_ws(text, i)
    if i >= len(text):
        raise _IncompleteGemmaValue
    if text.startswith(_GEMMA_STRING_DELIM, i):
        return _parse_gemma_string(text, i)
    if text[i] == '{':
        return _parse_gemma_mapping(text, i)
    if text[i] == '[':
        return _parse_gemma_array(text, i)
    if text.startswith('true', i) and _atom_end(text, i + 4):
        return True, i + 4
    if text.startswith('false', i) and _atom_end(text, i + 5):
        return False, i + 5
    if text.startswith('null', i) and _atom_end(text, i + 4):
        return None, i + 4
    num = re.match(r'-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?', text[i:])
    if num:
        raw = num.group(0)
        nxt = i + len(raw)
        if _atom_end(text, nxt):
            if any(ch in raw for ch in '.eE'):
                return float(raw), nxt
            return int(raw), nxt
    j = i
    while j < len(text) and text[j] not in ',}]\n\t\r ':
        j += 1
    if j == i:
        raise _IncompleteGemmaValue
    return text[i:j], j


def extract_gemma_native_tool_calls(text: str) -> list[dict[str, Any]]:
    """Convert complete Gemma ``<|tool_call>call:name{...}<tool_call|>`` blocks to LangChain tool_calls.

    Incomplete or unclosed blocks are skipped. Nested objects/arrays and ``<|"|>`` strings
    are brace-aware (Google's demo regex is not).
    """
    if not text or _TOOL_CALL_OPEN not in text:
        return []
    out: list[dict[str, Any]] = []
    i = 0
    while True:
        start = text.find(_TOOL_CALL_OPEN, i)
        if start < 0:
            break
        pos = _skip_ws(text, start + len(_TOOL_CALL_OPEN))
        if not text.startswith('call:', pos):
            i = start + 1
            continue
        pos = _skip_ws(text, pos + len('call:'))
        brace = text.find('{', pos)
        if brace < 0:
            break
        name = text[pos:brace].strip()
        if not name:
            i = brace + 1
            continue
        try:
            args, after = _parse_gemma_mapping(text, brace)
        except _IncompleteGemmaValue:
            i = start + 1
            continue
        after = _skip_ws(text, after)
        if not text.startswith(_TOOL_CALL_CLOSE, after):
            i = start + 1
            continue
        out.append(
            {
                'name': name,
                'args': args,
                'id': f'gemma-tool-{len(out) + 1}',
            }
        )
        i = after + len(_TOOL_CALL_CLOSE)
    return out


class GemmaStreamSplitter:
    """Incrementally split streamed Gemma 4 deltas into main vs reasoning lanes."""

    def __init__(self) -> None:
        self._pending = ''
        self._in_channel = False
        self._in_tool_call = False

    def feed(self, delta: str) -> tuple[str, str]:
        if not delta:
            return '', ''
        self._pending += delta
        main_parts: list[str] = []
        reason_parts: list[str] = []

        while self._pending:
            if self._in_channel:
                close_idx = self._pending.find('<channel|>')
                if close_idx == -1:
                    hold = _holdback_suffix_len(self._pending)
                    emit_len = len(self._pending) - hold
                    if emit_len <= 0:
                        break
                    reason_parts.append(self._pending[:emit_len])
                    self._pending = self._pending[emit_len:]
                    continue
                if close_idx > 0:
                    reason_parts.append(self._pending[:close_idx])
                self._pending = self._pending[close_idx + len('<channel|>') :]
                self._in_channel = False
                continue

            if self._in_tool_call:
                close_idx = self._pending.find(_TOOL_CALL_CLOSE)
                if close_idx == -1:
                    break
                self._pending = self._pending[close_idx + len(_TOOL_CALL_CLOSE) :]
                self._in_tool_call = False
                continue

            ch_idx = self._pending.find('<|channel>')
            tc_idx = self._pending.find(_TOOL_CALL_OPEN)
            if ch_idx == -1 and tc_idx == -1:
                hold = _holdback_suffix_len(self._pending)
                emit_len = len(self._pending) - hold
                if emit_len <= 0:
                    break
                chunk = _strip_gemma_control_tokens(self._pending[:emit_len])
                self._pending = self._pending[emit_len:]
                if chunk:
                    main_parts.append(chunk)
                continue

            if tc_idx == -1 or (ch_idx != -1 and ch_idx < tc_idx):
                next_idx = ch_idx
                kind = 'channel'
            else:
                next_idx = tc_idx
                kind = 'tool'

            if next_idx > 0:
                prefix = _strip_gemma_control_tokens(self._pending[:next_idx])
                if prefix:
                    main_parts.append(prefix)
                self._pending = self._pending[next_idx:]

            if kind == 'channel':
                open_match = _CHANNEL_OPEN_RE.match(self._pending)
                if not open_match:
                    break
                self._pending = self._pending[open_match.end() :]
                self._in_channel = True
                continue

            self._pending = self._pending[len(_TOOL_CALL_OPEN) :]
            self._in_tool_call = True

        return ''.join(main_parts), ''.join(reason_parts)

    def flush(self) -> tuple[str, str]:
        if not self._pending:
            return '', ''
        if self._in_channel:
            tail = self._pending
            self._pending = ''
            self._in_channel = False
            return '', tail
        if self._in_tool_call:
            self._pending = ''
            self._in_tool_call = False
            return '', ''
        main = _strip_gemma_control_tokens(self._pending)
        self._pending = ''
        return main, ''
