"""Parse Gemma 4 interleaved ``<|channel>`` assistant output into visible vs reasoning text.

Mirrors the inverse of Google's ``strip_thinking`` macro in ``chat_template.jinja``
(google/gemma-4-12B-it). Channel interiors route to reasoning; remaining text (including
``<|tool_call>`` blocks) stays in the visible stream for LangChain / the UI.
"""

from __future__ import annotations

import re

_CHANNEL_BLOCK_RE = re.compile(r'<\|channel>(\w+)\n(.*?)<channel\|>', re.DOTALL)
_CHANNEL_OPEN_RE = re.compile(r'<\|channel>\w+\n')

_CONTROL_TOKENS = (
    '<|turn>model\n',
    '<|turn>user\n',
    '<|turn>system\n',
    '<|think|>\n',
)

# Longest partial prefix we must hold back while streaming (``<|channel>``).
_STREAM_WATCH_TAGS = ('<|channel>', '<channel|>', '<|turn>', '<|think|>', '<|tool')


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


class GemmaStreamSplitter:
    """Incrementally split streamed Gemma 4 deltas into main vs reasoning lanes."""

    def __init__(self) -> None:
        self._pending = ''
        self._in_channel = False

    def feed(self, delta: str) -> tuple[str, str]:
        if not delta:
            return '', ''
        self._pending += delta
        main_parts: list[str] = []
        reason_parts: list[str] = []

        while self._pending:
            if not self._in_channel:
                open_idx = self._pending.find('<|channel>')
                if open_idx == -1:
                    hold = _holdback_suffix_len(self._pending)
                    emit_len = len(self._pending) - hold
                    if emit_len <= 0:
                        break
                    chunk = _strip_gemma_control_tokens(self._pending[:emit_len])
                    self._pending = self._pending[emit_len:]
                    if chunk:
                        main_parts.append(chunk)
                    continue
                if open_idx > 0:
                    prefix = _strip_gemma_control_tokens(self._pending[:open_idx])
                    if prefix:
                        main_parts.append(prefix)
                    self._pending = self._pending[open_idx:]
                open_match = _CHANNEL_OPEN_RE.match(self._pending)
                if not open_match:
                    break
                self._pending = self._pending[open_match.end() :]
                self._in_channel = True
                continue

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

        return ''.join(main_parts), ''.join(reason_parts)

    def flush(self) -> tuple[str, str]:
        if not self._pending:
            return '', ''
        if self._in_channel:
            tail = self._pending
            self._pending = ''
            self._in_channel = False
            return '', tail
        main = _strip_gemma_control_tokens(self._pending)
        self._pending = ''
        return main, ''
