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
    "verify with `lsp_get_diagnostics` (`refresh_active_document=true` on touched paths)."
)
VERIFY_READ = (
    "verify hits with `read_workspace_file`, LSP, or `search_workspace`."
)


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
    "describe",
]
