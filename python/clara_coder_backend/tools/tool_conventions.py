"""Shared constants and a `describe()` helper so tool docstrings stay consistent and cheap.

Compose these into docstrings instead of re-explaining the same rules per tool.
"""

import functools
import logging
import re
from collections.abc import Callable
from typing import Any, TypeVar

_F = TypeVar("_F", bound=Callable[..., Any])
_guard_logger = logging.getLogger("clara.tools")

# Fragments (no trailing period): ``describe()`` adds sentence punctuation, so compose freely.
ENCODING_NEWLINE = "`encoding` empty → Settings default; `newline` lf|crlf|preserve (match existing)"
ONE_BASED = "lines are 1-based inclusive after `\\n` normalization"
GUTTER = "gutter `n │ text` (U+2502); use `include_line_numbers=false` for raw lines/snippet matches"
RELATIVE_PATH = "workspace-relative POSIX path"
VERIFY_LSP = "`lsp_get_diagnostics` (`refresh_active_document=true` on touched paths)"
VERIFY_READ = "`read_workspace_file`, LSP, or `search_workspace` on the hits"

#: Hard cap on characters any one tool result returns to the model (head + tail kept).
TOOL_OUTPUT_MAX_CHARS = 30_000
#: Longest single source line a read/search tool returns before clipping it.
TOOL_LINE_MAX_CHARS = 500


def tool_output_cap(text: str, max_chars: int = TOOL_OUTPUT_MAX_CHARS) -> str:
    """Keep the head and tail of an oversized tool result with a marker in between."""
    if len(text) <= max_chars:
        return text
    head = max_chars * 2 // 3
    tail = max_chars - head
    omitted = len(text) - head - tail
    return f"{text[:head]}\n…[{omitted} chars omitted]…\n{text[-tail:]}"


def clip_line(line: str, max_chars: int = TOOL_LINE_MAX_CHARS) -> str:
    """Clip one very long line (minified bundles etc.) so a single line cannot flood the result."""
    if len(line) <= max_chars:
        return line
    return f"{line[:max_chars]}…[+{len(line) - max_chars} chars]"


def tool_errors_as_text(fn: _F) -> _F:
    """Return ``Tool error: …`` for bad paths / encodings / OS errors instead of raising.

    An uncaught exception in a tool aborts the agent run; these are the model's argument mistakes (path
    escapes, unknown codecs, unreadable or vanished files) and should come back as a fixable message.
    Apply under ``@tool`` so the schema still comes from the wrapped signature.
    """

    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        try:
            return fn(*args, **kwargs)
        except (ValueError, LookupError, UnicodeError, OSError) as exc:
            _guard_logger.info("%s returned tool error: %s", getattr(fn, "__name__", "tool"), exc)
            return f"Tool error: {exc}"

    return wrapper  # type: ignore[return-value]


def clamp_line_window(start: int, end: int, cap: int, *, max_value: int | None = None) -> tuple[int, int]:
    """Clamp a 1-based inclusive ``(start, end)`` window to at most ``cap`` entries.

    Treats ``end < start`` as "read up to ``cap`` entries from ``start``" rather than collapsing to a
    single entry. This matters because tool defaults for ``end_line``/``end_page`` are a fixed small
    number (sane when ``start`` is also near the beginning), but when a model continues pagination with
    a later ``start_line`` and omits ``end_line``, the unchanged default is smaller than ``start_line``—
    without this guard the window would silently shrink to one line/page per call instead of a full
    window, driving the model into a one-entry-at-a-time read loop.
    """
    safe_start = max(1, start)
    requested_end = end if end >= safe_start else safe_start + cap - 1
    safe_end = min(requested_end, safe_start + cap - 1)
    if max_value is not None:
        safe_end = min(safe_end, max_value)
    safe_end = max(safe_start, safe_end)
    return safe_start, safe_end


_DOUBLE_STOP_RE = re.compile(r"\.(?:\s*\.)+(?!\.)")
_STOP_BEFORE_SEMI_RE = re.compile(r"\.\s*;")


def _sentence(text: str) -> str:
    """Trim, collapse doubled stops (``..``, ``.;``) and end with exactly one terminal mark."""
    out = _STOP_BEFORE_SEMI_RE.sub(";", _DOUBLE_STOP_RE.sub(".", text.strip())).rstrip(";, ")
    if out and out[-1] not in ".!?…":
        out += "."
    return out


def describe(
    purpose: str,
    when: str = "",
    not_: str = "",
    shape: str = "",
    verify: str = "",
) -> str:
    """Return a compact description using the When:/Not:/Shape:/Verify: template."""
    parts = [_sentence(purpose)]
    if when:
        parts.append(f"When: {_sentence(when)}")
    if not_:
        parts.append(f"Not: {_sentence(not_)}")
    if shape:
        parts.append(f"Shape: {_sentence(shape)}")
    if verify:
        parts.append(f"Verify: {_sentence(verify)}")
    return " ".join(parts)


__all__ = [
    "ENCODING_NEWLINE",
    "ONE_BASED",
    "GUTTER",
    "RELATIVE_PATH",
    "TOOL_LINE_MAX_CHARS",
    "TOOL_OUTPUT_MAX_CHARS",
    "VERIFY_LSP",
    "VERIFY_READ",
    "clamp_line_window",
    "clip_line",
    "describe",
    "tool_errors_as_text",
    "tool_output_cap",
]
