"""Parse Gemma 4 interleaved ``<|channel>`` assistant output into visible vs reasoning text.

Uses the GGUF-embedded Jinja chat template (llama-server ``--jinja``), not a bundled file.
Channel interiors route to reasoning; remaining text (including ``<|tool_call>`` blocks)
stays in stored content so native calls can be promoted to LangChain ``tool_calls``.
After a tool response with ``enable_thinking``, the GGUF template may open thought in the
prompt — completions may have a ``<channel|>`` with no matching open tag. The stream
splitter holds complete tool-call blocks off the live token lane, but peeks the tool name
and path so the UI can show a running row while large write arguments still stream.
"""

from __future__ import annotations

import re
from typing import Any

_CHANNEL_BLOCK_RE = re.compile(r'<\|channel>\s*(\w+)\n?(.*?)<channel\|>', re.DOTALL)
# Official ``<|channel>thought\n`` plus model-echoed variants (missing pipes / spaces).
_CHANNEL_OPEN_RE = re.compile(
    r'<\|channel>\s*\w+\n?'
    r'|<\|channel>\n?'
    r'|<\|channel\s+\w+\s*\|?>\n?'
    r'|<channel\s+\w+\s*>\n?'
    r'|<channel>\s*\w*\n?'
)
_CHANNEL_MARKUP_RE = re.compile(
    r'<\|channel>\s*\w*\n?'
    r'|<channel\|>'
    r'|<\|channel\s+\w+\s*\|?>'
    r'|<channel\s+\w+\s*>'
    r'|<channel>\s*\w*\n?'
)
_CHANNEL_MARKUP_HINT_RE = re.compile(r'<\|channel>|<channel\|>|<channel\s+\w+\s*>|<channel>')
_INCOMPLETE_CHANNEL_MARKUP_RE = re.compile(r'<\|?channel(?:\s+\w*|\|?\w*)?$', re.IGNORECASE)

_CONTROL_TOKENS = (
    '<|turn>model\n',
    '<|turn>user\n',
    '<|turn>system\n',
    '<|think|>\n',
    '<|think|>',
    '<turn|>\n',
    '<turn|>',
    '<channel|>',
)

_TOOL_CALL_OPEN = '<|tool_call>'
_TOOL_CALL_CLOSE = '<tool_call|>'
_CHANNEL_CLOSE = '<channel|>'
_GEMMA_STRING_DELIM = '<|"|>'
# Names the GGUF tokenizer emits as their own token after ``<|channel>``.
_CHANNEL_NAMES = ('thought', 'commentary')
_CHANNEL_NAME_RE = re.compile(r'(thought|commentary)(\n)?')

# Longest partial prefix we must hold back while streaming (``<|channel>`` / tool tags).
_STREAM_WATCH_TAGS = (
    '<|channel>',
    '<channel|>',
    '<channel ',
    '<channel>',
    '<|turn>',
    '<turn|>',
    '<|think|>',
    '<|tool_call>',
    '<tool_call|>',
    '<|tool',
)

# Completion prefixes that mean this step did *not* start inside a prompt-opened thought channel.
_EXPLICIT_STREAM_STARTS = (
    '<|channel>',
    '<|tool_call>',
    '<|turn>',
    '<|think|>',
    '<channel|>',
    '<channel ',
    '<channel>',
)


class _IncompleteGemmaValue(Exception):
    """Native tool-call argument payload is truncated or malformed."""


def _strip_gemma_control_tokens(text: str) -> str:
    return strip_gemma_channel_markup(text)


def strip_gemma_channel_markup(text: str) -> str:
    """Remove Gemma channel / turn control tags so they never reach the UI."""
    if not text:
        return ''
    out = _CHANNEL_MARKUP_RE.sub('', text)
    for tok in _CONTROL_TOKENS:
        out = out.replace(tok, '')
    return out


def _holdback_suffix_len(text: str) -> int:
    """How many trailing chars might be the start of a control tag."""
    if not text:
        return 0
    max_len = max(len(w) for w in _STREAM_WATCH_TAGS)
    upper = min(len(text), max_len)
    hold = 0
    for length in range(upper, 0, -1):
        suffix = text[-length:]
        if any(tag.startswith(suffix) for tag in _STREAM_WATCH_TAGS):
            hold = length
            break
    lt = text.rfind('<')
    if lt != -1:
        suffix = text[lt:]
        if '\n' not in suffix and len(suffix) < 48 and _INCOMPLETE_CHANNEL_MARKUP_RE.match(suffix):
            hold = max(hold, len(suffix))
    return hold


def _channel_open_span(text: str) -> tuple[int, int] | None:
    match = _CHANNEL_OPEN_RE.search(text)
    if match is None:
        return None
    return match.start(), match.end()


def _channel_open_lacks_name(matched: str) -> bool:
    return not any(name in matched for name in _CHANNEL_NAMES)


def _try_consume_channel_name(pending: str) -> tuple[str, bool]:
    """Strip a GGUF channel name token from ``pending``.

    Returns ``(pending, wait)``. ``wait`` means the leading bytes might still be a
    name prefix (``tho`` / bare ``thought``) so the caller must not emit them yet.
    """
    match = _CHANNEL_NAME_RE.match(pending)
    if match is None:
        leader = re.match(r'\w*', pending)
        prefix = leader.group(0) if leader else ''
        if prefix and any(name.startswith(prefix) for name in _CHANNEL_NAMES):
            return pending, True
        return pending, False
    newline = match.group(2)
    rest = pending[match.end() :]
    if newline is None and not rest:
        return pending, True
    if newline is None and rest[:1].isalnum():
        return pending, False
    return rest, False


def split_gemma_channels(text: str) -> tuple[str, str]:
    """Split raw assistant content into ``(visible, reasoning)``."""
    if not text:
        return '', ''
    if not gemma_content_needs_parsing(text):
        cleaned = _strip_gemma_control_tokens(text).strip()
        return cleaned, ''

    reasoning_parts: list[str] = []

    def _collect(match: re.Match[str]) -> str:
        reasoning_parts.append(match.group(2))
        return ''

    visible = _CHANNEL_BLOCK_RE.sub(_collect, text)
    while True:
        close_idx = visible.find(_CHANNEL_CLOSE)
        open_m = _CHANNEL_OPEN_RE.search(visible)
        if close_idx != -1 and (open_m is None or close_idx < open_m.start()):
            # Prompt-opened thought (GGUF template after tool_response + enable_thinking):
            # completion has no open tag, only a later ``<channel|>``.
            reasoning_parts.append(visible[:close_idx])
            visible = visible[close_idx + len(_CHANNEL_CLOSE) :]
            continue
        if open_m is not None and close_idx != -1 and close_idx >= open_m.end():
            reasoning_parts.append(visible[open_m.end() : close_idx])
            visible = visible[: open_m.start()] + visible[close_idx + len(_CHANNEL_CLOSE) :]
            continue
        break
    # Unclosed channel (streaming tail): treat remainder as reasoning.
    open_m = _CHANNEL_OPEN_RE.search(visible)
    if open_m:
        reasoning_parts.append(visible[open_m.end() :])
        visible = visible[: open_m.start()]
    visible, peeled_reason = _peel_prose_around_native_tool_calls(visible)
    if peeled_reason:
        reasoning_parts.append(peeled_reason)
    visible = strip_gemma_channel_markup(visible)
    reasoning = strip_gemma_channel_markup(''.join(reasoning_parts))
    return visible.strip(), reasoning.strip()


def gemma_content_needs_parsing(text: str) -> bool:
    return bool(text) and bool(_CHANNEL_MARKUP_HINT_RE.search(text))


def _peel_prose_around_native_tool_calls(visible: str) -> tuple[str, str]:
    """Move untagged planning prose around ``<|tool_call>`` blocks onto the reasoning lane.

    After an empty ``<|channel>thought\\n<channel|>``, Gemma often keeps thinking without a
    second open tag, then emits a native tool call. That span is thought, not the answer.
    """
    if not visible or _TOOL_CALL_OPEN not in visible:
        return visible, ''
    reason_parts: list[str] = []
    kept: list[str] = []
    i = 0
    while True:
        start = visible.find(_TOOL_CALL_OPEN, i)
        if start < 0:
            kept.append(visible[i:])
            break
        prefix = visible[i:start]
        if prefix.strip():
            reason_parts.append(prefix)
        close = visible.find(_TOOL_CALL_CLOSE, start)
        if close < 0:
            kept.append(visible[start:])
            break
        kept.append(visible[start : close + len(_TOOL_CALL_CLOSE)])
        i = close + len(_TOOL_CALL_CLOSE)
    return ''.join(kept), ''.join(reason_parts)


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


def _parse_json_string(text: str, i: int) -> tuple[str, int]:
    if i >= len(text) or text[i] != '"':
        raise _IncompleteGemmaValue
    i += 1
    out: list[str] = []
    while i < len(text):
        ch = text[i]
        if ch == '\\':
            if i + 1 >= len(text):
                raise _IncompleteGemmaValue
            out.append(text[i + 1])
            i += 2
            continue
        if ch == '"':
            return ''.join(out), i + 1
        out.append(ch)
        i += 1
    raise _IncompleteGemmaValue


def _parse_gemma_key(text: str, i: int) -> tuple[str, int]:
    if text.startswith(_GEMMA_STRING_DELIM, i):
        return _parse_gemma_string(text, i)
    if i < len(text) and text[i] == '"':
        return _parse_json_string(text, i)
    colon = text.find(':', i)
    if colon < 0:
        raise _IncompleteGemmaValue
    key = text[i:colon].strip()
    if not key:
        raise _IncompleteGemmaValue
    return key, colon


def _is_gemma_key_start(text: str, i: int) -> bool:
    if i >= len(text):
        return False
    if text.startswith(_GEMMA_STRING_DELIM, i) or text[i] == '"':
        return True
    ch = text[i]
    return ch == '_' or ch.isalpha()


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
        key, i = _parse_gemma_key(text, i)
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
        if text[i] == ',':
            i += 1
            continue
        # Gemma sometimes separates fields with a newline and no comma.
        if _is_gemma_key_start(text, i):
            continue
        raise _IncompleteGemmaValue


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
    if text[i] == '"':
        return _parse_json_string(text, i)
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


def _parse_complete_gemma_fields(text: str) -> dict[str, Any]:
    """Parse as many complete key/value pairs as possible from a truncated ``{...`` mapping."""
    if not text or text[0] != '{':
        return {}
    out: dict[str, Any] = {}
    i = 1
    while True:
        i = _skip_ws(text, i)
        if i >= len(text) or text[i] == '}':
            return out
        try:
            key, i = _parse_gemma_key(text, i)
            i = _skip_ws(text, i)
            if i >= len(text) or text[i] != ':':
                return out
            value, i = _parse_gemma_value(text, i + 1)
            out[key] = value
            i = _skip_ws(text, i)
            if i >= len(text):
                return out
            if text[i] == '}':
                return out
            if text[i] == ',':
                i += 1
                continue
            if _is_gemma_key_start(text, i):
                continue
            return out
        except _IncompleteGemmaValue:
            return out


_PATH_ALIAS_KEYS = ('path', 'file_path')
_CONTENT_ALIAS_KEYS = ('content',)


def normalize_gemma_tool_args(args: dict[str, Any]) -> dict[str, Any]:
    """Map Gemma-trained names (``path`` / ``file_path`` / ``content``) onto Clara parameters.

    Gemma 4 write examples use ``path``/``file_path`` and ``content``, often with content first.
    Clara tools require ``relative_path`` and ``new_content``. Extra alias keys are dropped so
    LangChain does not pass unexpected kwargs into the tool.
    """
    if not args:
        return args
    out = dict(args)
    rel = out.get('relative_path')
    if not (isinstance(rel, str) and rel.strip()):
        for key in _PATH_ALIAS_KEYS:
            val = out.get(key)
            if isinstance(val, str) and val.strip():
                out['relative_path'] = val.strip()
                break
    if 'new_content' not in out:
        for key in _CONTENT_ALIAS_KEYS:
            if key in out:
                out['new_content'] = out[key]
                break
    for key in _PATH_ALIAS_KEYS:
        out.pop(key, None)
    for key in _CONTENT_ALIAS_KEYS:
        out.pop(key, None)
    return out


def _tool_peek_path(args: dict[str, Any]) -> str:
    for key in ('relative_path', 'path', 'file_path'):
        val = args.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return ''


def peek_partial_native_tool_call(interior: str) -> dict[str, Any] | None:
    """Best-effort ``name`` / ``args`` from an unclosed native tool-call interior.

    The interior is the text after ``<|tool_call>`` and before ``<tool_call|>``.
    A name is only returned once the opening ``{`` is present so it is complete.
    Completed argument fields (typically ``relative_path``) are included even while
    a later string such as ``new_content`` is still streaming.
    """
    if not interior:
        return None
    text = interior.lstrip()
    if not text.startswith('call:'):
        return None
    pos = _skip_ws(text, len('call:'))
    brace = text.find('{', pos)
    if brace < 0:
        return None
    name = text[pos:brace].strip()
    if not name:
        return None
    raw_args = normalize_gemma_tool_args(_parse_complete_gemma_fields(text[brace:]))
    args = {
        key: val
        for key, val in raw_args.items()
        if key in ('relative_path', 'path', 'query') and isinstance(val, str) and val.strip()
    }
    return {'name': name, 'args': args}


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
                'args': normalize_gemma_tool_args(args),
                'id': f'gemma-tool-{len(out) + 1}',
            }
        )
        i = after + len(_TOOL_CALL_CLOSE)
    return out


def strip_gemma_native_tool_call_blocks(text: str) -> str:
    """Remove complete ``<|tool_call>...<tool_call|>`` blocks from assistant text."""
    if not text or _TOOL_CALL_OPEN not in text:
        return text
    parts: list[str] = []
    i = 0
    while True:
        start = text.find(_TOOL_CALL_OPEN, i)
        if start < 0:
            parts.append(text[i:])
            break
        parts.append(text[i:start])
        close = text.find(_TOOL_CALL_CLOSE, start)
        if close < 0:
            break
        i = close + len(_TOOL_CALL_CLOSE)
    return ''.join(parts)


class GemmaStreamSplitter:
    """Incrementally split streamed Gemma 4 deltas into main vs reasoning lanes.

    ``start_in_channel`` is for the GGUF template's post-tool generation prompt, which
    opens ``<|channel>thought`` in the *prompt* so the completion starts mid-channel.
    The first non-tag bytes are treated as thought; an explicit ``<|channel>`` /
    ``<|tool_call>`` prefix cancels that assumption.
    """

    def __init__(self, *, start_in_channel: bool = False) -> None:
        self._pending = ''
        self._in_channel = False
        self._in_tool_call = False
        self._maybe_implicit_channel = start_in_channel
        self._awaiting_channel_name = False
        # After an empty ``<|channel>thought\\n<channel|>``, later untagged bytes may
        # still be thought (second ``<channel|>``) or the answer (flush). Hold them.
        self._holding_after_empty_close = False
        self._held_after_empty = ''
        # Native tool calls after actual thought should resume the thought lane for later
        # untagged prose (Gemma often thinks between parallel ``<|tool_call>`` blocks).
        self._resume_thought_after_tool = False
        self._tool_peek_name: str | None = None
        self._tool_peek_path: str | None = None
        self._tool_peeks: list[dict[str, Any]] = []

    def drain_tool_peeks(self) -> list[dict[str, Any]]:
        """Return and clear tool-call heads noticed since the last drain."""
        items = self._tool_peeks
        self._tool_peeks = []
        return items

    def _announce_open_tool_peek(self, interior: str) -> None:
        peeked = peek_partial_native_tool_call(interior)
        if peeked is None:
            return
        name = str(peeked.get('name') or '')
        args = peeked.get('args') if isinstance(peeked.get('args'), dict) else {}
        path = _tool_peek_path(args)
        if self._tool_peek_name != name:
            self._tool_peek_name = name
            self._tool_peek_path = path
            self._tool_peeks.append({'name': name, 'args': args, 'update': False})
            return
        if path and path != self._tool_peek_path:
            self._tool_peek_path = path
            self._tool_peeks.append({'name': name, 'args': args, 'update': True})

    def _reset_open_tool_peek(self) -> None:
        self._tool_peek_name = None
        self._tool_peek_path = None

    def _emit_held_as_main(self, main_parts: list[str]) -> None:
        if self._held_after_empty:
            main_parts.append(self._held_after_empty)
        self._held_after_empty = ''
        self._holding_after_empty_close = False

    def _emit_held_as_reason(self, reason_parts: list[str]) -> None:
        if self._held_after_empty:
            reason_parts.append(self._held_after_empty)
        self._held_after_empty = ''
        self._holding_after_empty_close = False

    def _commit_implicit_channel_if_ready(self) -> bool:
        """Return True when the caller should wait for more bytes."""
        if not self._maybe_implicit_channel or self._in_channel or self._in_tool_call:
            return False
        leader = self._pending.lstrip()
        if not leader:
            return True
        if any(tag.startswith(leader) for tag in _STREAM_WATCH_TAGS) and not any(
            leader.startswith(tag) for tag in _EXPLICIT_STREAM_STARTS
        ):
            return True
        if any(leader.startswith(tag) for tag in _EXPLICIT_STREAM_STARTS):
            self._maybe_implicit_channel = False
            return False
        self._in_channel = True
        self._maybe_implicit_channel = False
        self._resume_thought_after_tool = True
        return False

    def feed(self, delta: str) -> tuple[str, str]:
        if not delta:
            return '', ''
        self._pending += delta
        main_parts: list[str] = []
        reason_parts: list[str] = []

        while self._pending:
            if self._commit_implicit_channel_if_ready():
                break
            if self._in_channel:
                if self._awaiting_channel_name:
                    self._pending, wait_name = _try_consume_channel_name(self._pending)
                    if wait_name:
                        break
                    self._awaiting_channel_name = False
                    if not self._pending:
                        break
                close_idx = self._pending.find(_CHANNEL_CLOSE)
                open_span = _channel_open_span(self._pending)
                nested_at = open_span[0] if open_span else -1
                tc_idx = self._pending.find(_TOOL_CALL_OPEN)
                if tc_idx != -1 and (close_idx == -1 or tc_idx < close_idx) and (
                    nested_at == -1 or tc_idx < nested_at
                ):
                    if tc_idx > 0:
                        reason_parts.append(self._pending[:tc_idx])
                    self._pending = self._pending[tc_idx + len(_TOOL_CALL_OPEN) :]
                    self._in_channel = False
                    self._awaiting_channel_name = False
                    self._in_tool_call = True
                    self._resume_thought_after_tool = True
                    self._emit_held_as_reason(reason_parts)
                    continue
                if close_idx != -1 and (nested_at == -1 or close_idx < nested_at):
                    interior = self._pending[:close_idx]
                    rest = self._pending[close_idx + len(_CHANNEL_CLOSE) :]
                    if close_idx > 0:
                        reason_parts.append(interior)
                    self._pending = rest
                    self._in_channel = False
                    self._awaiting_channel_name = False
                    # Empty close with nothing after it in this chunk: next untagged
                    # tokens may still be thought until a later ``<channel|>``.
                    self._holding_after_empty_close = not interior.strip() and not rest
                    if self._holding_after_empty_close:
                        self._resume_thought_after_tool = True
                    if not self._holding_after_empty_close:
                        self._emit_held_as_main(main_parts)
                    continue
                if open_span is not None:
                    start, end = open_span
                    if end <= start:
                        break
                    if start > 0:
                        reason_parts.append(self._pending[:start])
                    matched = self._pending[start:end]
                    self._pending = self._pending[end:]
                    self._awaiting_channel_name = _channel_open_lacks_name(matched)
                    continue
                hold = _holdback_suffix_len(self._pending)
                emit_len = len(self._pending) - hold
                if emit_len <= 0:
                    break
                reason_parts.append(self._pending[:emit_len])
                self._pending = self._pending[emit_len:]
                continue

            if self._in_tool_call:
                close_idx = self._pending.find(_TOOL_CALL_CLOSE)
                if close_idx == -1:
                    break
                self._announce_open_tool_peek(self._pending[:close_idx])
                self._pending = self._pending[close_idx + len(_TOOL_CALL_CLOSE) :]
                self._in_tool_call = False
                self._reset_open_tool_peek()
                if self._resume_thought_after_tool:
                    self._maybe_implicit_channel = True
                continue

            open_span = _channel_open_span(self._pending)
            tc_idx = self._pending.find(_TOOL_CALL_OPEN)
            close_idx = self._pending.find(_CHANNEL_CLOSE)
            candidates: list[tuple[int, str]] = []
            if open_span is not None:
                candidates.append((open_span[0], 'channel'))
            if tc_idx != -1:
                candidates.append((tc_idx, 'tool'))
            if close_idx != -1:
                candidates.append((close_idx, 'orphan_close'))
            if not candidates:
                hold = _holdback_suffix_len(self._pending)
                emit_len = len(self._pending) - hold
                if emit_len <= 0:
                    break
                chunk = strip_gemma_channel_markup(self._pending[:emit_len])
                self._pending = self._pending[emit_len:]
                if chunk:
                    if self._holding_after_empty_close:
                        self._held_after_empty += chunk
                    else:
                        main_parts.append(chunk)
                continue

            next_idx, kind = min(candidates, key=lambda item: item[0])
            if next_idx > 0:
                prefix = self._pending[:next_idx]
                self._pending = self._pending[next_idx:]
                if kind == 'orphan_close':
                    if self._holding_after_empty_close:
                        self._held_after_empty += prefix
                    elif prefix:
                        reason_parts.append(prefix)
                else:
                    cleaned = strip_gemma_channel_markup(prefix)
                    if cleaned:
                        if self._holding_after_empty_close:
                            self._held_after_empty += cleaned
                        else:
                            main_parts.append(cleaned)

            if kind == 'orphan_close':
                self._pending = self._pending[len(_CHANNEL_CLOSE) :]
                self._maybe_implicit_channel = False
                self._emit_held_as_reason(reason_parts)
                self._resume_thought_after_tool = True
                continue

            if kind == 'channel':
                self._emit_held_as_reason(reason_parts)
                open_match = _CHANNEL_OPEN_RE.match(self._pending)
                if not open_match:
                    break
                self._awaiting_channel_name = _channel_open_lacks_name(open_match.group(0))
                self._pending = self._pending[open_match.end() :]
                self._in_channel = True
                self._resume_thought_after_tool = True
                continue

            self._emit_held_as_reason(reason_parts)
            self._pending = self._pending[len(_TOOL_CALL_OPEN) :]
            self._in_tool_call = True

        if self._in_tool_call:
            self._announce_open_tool_peek(self._pending)
        return (
            strip_gemma_channel_markup(''.join(main_parts)),
            strip_gemma_channel_markup(''.join(reason_parts)),
        )

    def flush(self) -> tuple[str, str]:
        held = strip_gemma_channel_markup(self._held_after_empty)
        self._held_after_empty = ''
        self._holding_after_empty_close = False
        self._awaiting_channel_name = False
        if (
            not self._pending
            and not self._in_channel
            and not self._maybe_implicit_channel
            and not held
        ):
            return '', ''
        if self._in_channel or self._maybe_implicit_channel:
            tail = strip_gemma_channel_markup(self._pending)
            self._pending = ''
            self._in_channel = False
            self._maybe_implicit_channel = False
            return held, tail
        if self._in_tool_call:
            if self._tool_peek_name:
                self._tool_peeks.append(
                    {
                        'name': self._tool_peek_name,
                        'args': {},
                        'cancelled': True,
                    }
                )
            self._pending = ''
            self._in_tool_call = False
            self._reset_open_tool_peek()
            return held, ''
        main = strip_gemma_channel_markup(self._pending)
        self._pending = ''
        return f'{held}{main}', ''
