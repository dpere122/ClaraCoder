"""Shared constants and a `describe()` helper so tool docstrings stay consistent and cheap.

Compose these into docstrings instead of re-explaining the same rules per tool.
"""

ENCODING_NEWLINE = (
    "`encoding` empty → Settings default; `newline` lf|crlf|preserve (match existing)."
)
ONE_BASED = "lines are 1-based inclusive after `\\n` normalization."
GUTTER = (
    "gutter `n │ text` (U+2502); use `include_line_numbers=false` for raw lines/snippet matches."
)
RELATIVE_PATH = "workspace-relative POSIX path."
STAGE_LAND = (
    "`land_in_workspace`: false while iterating/reviewing, true on the final call to land in one step (HITL diff when auto-apply off)."
)
VERIFY_LSP = (
    "verify with `lsp_get_diagnostics` (`refresh_active_document=true` on touched paths; "
    "`scope=staging` or `scope=workspace` as needed — both work regardless of auto-apply)."
)
VERIFY_READ = (
    "verify hits with `read_workspace_file`, LSP, or `search_workspace`."
)


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


def describe(
    purpose: str,
    when: str = "",
    not_: str = "",
    shape: str = "",
    verify: str = "",
) -> str:
    """Return a compact docstring body using the When:/Not:/Shape:/Verify: template."""
    parts = [purpose.rstrip()]
    if when:
        parts.append(f"When: {when.rstrip()}")
    if not_:
        parts.append(f"Not: {not_.rstrip()}")
    if shape:
        parts.append(f"Shape: {shape.rstrip()}")
    if verify:
        parts.append(f"Verify: {verify.rstrip()}")
    return " ".join(parts)


__all__ = [
    "ENCODING_NEWLINE",
    "ONE_BASED",
    "GUTTER",
    "RELATIVE_PATH",
    "STAGE_LAND",
    "VERIFY_LSP",
    "VERIFY_READ",
    "clamp_line_window",
    "describe",
]
