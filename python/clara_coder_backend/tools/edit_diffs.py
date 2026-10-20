"""Per-call unified diffs of workspace edits, for the UI only.

An edit tool records the diff of what it wrote under its ``tool_call_id``. The stream layer takes it when the tool
finishes and sends it with the finished status, so the expanded edit pill can show what changed. The model never
sees the diff: its tool result stays the one-line summary plus the post-edit checks.
"""

from __future__ import annotations

import difflib
import threading
from collections import OrderedDict

__all__ = ['edit_unified_diff', 'record_edit_diff', 'take_edit_diff']

# Big rewrites are cut at this many diff lines / characters; the UI shows the cut marker.
MAX_DIFF_LINES = 400
MAX_DIFF_CHARS = 48_000
# Diffs nobody took (a failed stream, a nested graph we do not render) are dropped oldest first.
_MAX_PENDING = 256

_pending: OrderedDict[str, str] = OrderedDict()
_lock = threading.Lock()


def edit_unified_diff(relative_path: str, old_text: str, new_text: str, *, existed: bool = True) -> str:
    """Unified diff (3 lines of context) of one edit; empty when nothing changed."""
    if old_text == new_text:
        return ''
    lines = list(
        difflib.unified_diff(
            old_text.splitlines(),
            new_text.splitlines(),
            fromfile=f'a/{relative_path}' if existed else '/dev/null',
            tofile=f'b/{relative_path}',
            lineterm='',
        )
    )
    out: list[str] = []
    size = 0
    for i, line in enumerate(lines):
        if i >= MAX_DIFF_LINES or size + len(line) + 1 > MAX_DIFF_CHARS:
            out.append(f'\\ Diff cut: {len(lines) - i} more lines')
            break
        out.append(line)
        size += len(line) + 1
    return '\n'.join(out)


def record_edit_diff(tool_call_id: str, diff: str) -> None:
    """Keep ``diff`` for the stream layer to send with this call's finished status."""
    if not tool_call_id or not diff:
        return
    with _lock:
        _pending[tool_call_id] = diff
        _pending.move_to_end(tool_call_id)
        while len(_pending) > _MAX_PENDING:
            _pending.popitem(last=False)


def take_edit_diff(tool_call_id: str) -> str:
    """Remove and return the diff recorded for ``tool_call_id`` (empty when there is none)."""
    if not tool_call_id:
        return ''
    with _lock:
        return _pending.pop(tool_call_id, '')
