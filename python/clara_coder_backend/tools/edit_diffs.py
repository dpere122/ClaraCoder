"""Per-call unified diffs of workspace edits, for the UI only.

An edit tool records the diff of what it wrote under its ``tool_call_id``. The stream layer takes it when the tool
finishes and sends it with the finished status, so the expanded edit pill can show what changed. The model never
sees the diff: its tool result stays the one-line summary plus the post-edit checks.
"""

from __future__ import annotations

import difflib
import threading
from collections import OrderedDict

from clara_coder_backend.session.state import current_session_id

__all__ = ['discard_edit_diff', 'edit_unified_diff', 'record_edit_diff', 'take_edit_diff']

# Big rewrites are cut at this many diff lines / characters; the UI shows the cut marker.
MAX_DIFF_LINES = 400
MAX_DIFF_CHARS = 48_000
# Diffs nobody took (a failed stream, a nested graph we do not render) are dropped oldest first.
_MAX_PENDING = 256

# Keyed by (session id, tool call id): some providers' call ids repeat every step (``gemma-tool-1``,
# ``xml-tool-1``), so the bare call id would hand one session's diff to another's call.
_pending: OrderedDict[tuple[str, str], str] = OrderedDict()
_lock = threading.Lock()


def _key(tool_call_id: str) -> tuple[str, str]:
    return (current_session_id.get() or '', tool_call_id)


def edit_unified_diff(relative_path: str, old_text: str, new_text: str, *, existed: bool = True) -> str:
    """Unified diff (3 lines of context) of one edit; empty when nothing changed.

    Past the cut, lines are only counted, not kept. The marker carries the cut part's added / deleted counts
    (``\\ Diff cut: 1600 more lines (+1590 -10)``) so the pill's ``+N −M`` stays exact.
    """
    if old_text == new_text:
        return ''
    out: list[str] = []
    size = 0
    cut = added = deleted = 0
    for line in difflib.unified_diff(
        old_text.splitlines(),
        new_text.splitlines(),
        fromfile=f'a/{relative_path}' if existed else '/dev/null',
        tofile=f'b/{relative_path}',
        lineterm='',
    ):
        if cut or len(out) >= MAX_DIFF_LINES or size + len(line) + 1 > MAX_DIFF_CHARS:
            # The file headers are always kept, so every cut ``+`` / ``-`` line is a row.
            cut += 1
            added += line.startswith('+')
            deleted += line.startswith('-')
            continue
        out.append(line)
        size += len(line) + 1
    if cut:
        out.append(f'\\ Diff cut: {cut} more lines (+{added} -{deleted})')
    return '\n'.join(out)


def record_edit_diff(tool_call_id: str, diff: str) -> None:
    """Keep ``diff`` for the stream layer to send with this call's finished status.

    A call that writes several files (e.g. a project bootstrap) appends one file diff per write.
    """
    if not tool_call_id or not diff:
        return
    key = _key(tool_call_id)
    with _lock:
        prev = _pending.get(key)
        _pending[key] = f'{prev}\n{diff}' if prev else diff
        _pending.move_to_end(key)
        while len(_pending) > _MAX_PENDING:
            _pending.popitem(last=False)


def take_edit_diff(tool_call_id: str) -> str:
    """Remove and return the diff recorded for ``tool_call_id`` (empty when there is none)."""
    if not tool_call_id:
        return ''
    with _lock:
        return _pending.pop(_key(tool_call_id), '')


def discard_edit_diff(tool_call_id: str) -> None:
    """Drop a diff an earlier call with the same (reused) id left behind, before this call runs."""
    take_edit_diff(tool_call_id)
