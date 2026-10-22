"""Per-file write locks and per-batch line maps shared by every tool that writes workspace files.

Parallel tool calls run in a thread pool. A tool that writes a file holds that file's lock from its read to its
last side effect, so writes of one file apply one after another, whichever tool makes them.

Every call in one model response (a tool batch, see ``current_tool_batch_id``) took its line numbers from the
files as they were before the response. The first write of a file in a batch keeps a map from those lines to
the file's current lines, and each later write updates it, so a line-range edit can be moved onto the shifted
file. Lines the batch already changed map to nothing, and an edit touching them is refused.
"""

from __future__ import annotations

import os
import threading
from collections import OrderedDict
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from clara_coder_backend.session.state import current_session_id, current_tool_batch_id

__all__ = ['BatchLineMap', 'batch_line_map', 'locked_path', 'note_batch_replaced', 'note_batch_write']

# Keyed by normcased absolute path, so writes from every session to one file on disk share a lock.
_path_locks: dict[str, threading.Lock] = {}
_path_locks_guard = threading.Lock()

# Line maps of recent batches, oldest dropped first. Keyed by (session id, batch id, path key).
_MAX_BATCH_FILES = 512
_batch_files: OrderedDict[tuple[str, str, str], BatchLineMap] = OrderedDict()
_batch_files_guard = threading.Lock()


@contextmanager
def locked_path(path: Path) -> Iterator[str]:
    """Hold ``path``'s write lock; yields the key it is registered under."""
    key = os.path.normcase(os.path.abspath(path))
    with _path_locks_guard:
        lock = _path_locks.setdefault(key, threading.Lock())
    with lock:
        yield key


class BatchLineMap:
    """Where each line of a file from before the batch is now (line numbers as ``str.splitlines`` counts them)."""

    def __init__(self, base_text: str) -> None:
        self.base_line_count = len(base_text.splitlines())
        #: 0-based current line of each base line; None once a write in the batch changed or removed it.
        self._current: list[int | None] = list(range(self.base_line_count))
        self._current_line_count = self.base_line_count
        #: Set once the batch replaced the file wholesale (a copy over it, a delete); no range maps after that.
        self._replaced = False

    def apply_write(self, before: str, after: str) -> None:
        """Move the map past one write. The change is the span between the common leading and trailing lines."""
        if self._replaced:
            return
        old, new = before.splitlines(), after.splitlines()
        lead = 0
        limit = min(len(old), len(new))
        while lead < limit and old[lead] == new[lead]:
            lead += 1
        trail = 0
        while trail < limit - lead and old[-1 - trail] == new[-1 - trail]:
            trail += 1
        changed_end = len(old) - trail
        shift = len(new) - len(old)
        for i, cur in enumerate(self._current):
            if cur is None or cur < lead:
                continue
            self._current[i] = cur + shift if cur >= changed_end else None
        self._current_line_count = len(new)

    def replace_all(self) -> None:
        """Every base line is gone (the file was replaced by unrelated content, or deleted)."""
        self._replaced = True

    def map_range(self, start_line: int, end_line: int) -> tuple[int, int] | None:
        """Current 1-based inclusive range for base lines ``start_line..end_line``; None when the batch changed any.

        The append position (``base_line_count + 1`` for both) maps to after the current last line. A range past
        the end of the base file is None too: lines another call appended there are not the ones the caller read.
        """
        if self._replaced:
            return None
        n = self.base_line_count
        if start_line == end_line == n + 1:
            return self._current_line_count + 1, self._current_line_count + 1
        if end_line > n:
            return None
        span = self._current[start_line - 1 : end_line]
        first = span[0]
        if first is None or any(cur != first + k for k, cur in enumerate(span)):
            # Changed, removed, or split by lines inserted inside the range.
            return None
        return first + 1, first + len(span)


def _batch_key(path_key: str) -> tuple[str, str, str] | None:
    batch = current_tool_batch_id.get()
    if not batch:
        return None
    return (current_session_id.get() or '', batch, path_key)


def batch_line_map(path_key: str) -> BatchLineMap | None:
    """This batch's line map for ``path_key``; None when no call in the batch has written it yet.

    Call with ``path_key``'s lock held.
    """
    key = _batch_key(path_key)
    if key is None:
        return None
    with _batch_files_guard:
        return _batch_files.get(key)


def _batch_entry(path_key: str, before: str) -> BatchLineMap | None:
    key = _batch_key(path_key)
    if key is None:
        return None
    with _batch_files_guard:
        line_map = _batch_files.get(key)
        if line_map is None:
            line_map = BatchLineMap(before)
            _batch_files[key] = line_map
        _batch_files.move_to_end(key)
        while len(_batch_files) > _MAX_BATCH_FILES:
            _batch_files.popitem(last=False)
    return line_map


def note_batch_write(path_key: str, before: str, after: str) -> None:
    """Record an edit of ``path_key`` (text ``before`` → ``after``) in this batch. Call with its lock held."""
    line_map = _batch_entry(path_key, before)
    if line_map is not None:
        line_map.apply_write(before, after)


def note_batch_replaced(path_key: str) -> None:
    """Record that this batch replaced or deleted ``path_key`` wholesale. Call with its lock held."""
    line_map = _batch_entry(path_key, '')
    if line_map is not None:
        line_map.replace_all()
