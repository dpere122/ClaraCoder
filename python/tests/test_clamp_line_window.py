"""Regression coverage for the read-window pagination bug.

Tools like ``read_workspace_file`` and ``read_staged_edit`` default ``end_line`` to a small fixed
number (sane when ``start_line`` defaults to 1). When a model continues pagination by passing only a
later ``start_line`` and omitting ``end_line``, the unchanged small default used to be *less than*
``start_line``, which collapsed the returned window to a single line per call and could drive the
agent loop into a one-line-at-a-time read loop until it hit the recursion limit.
"""

from __future__ import annotations

from clara_coder_backend.domain import EditStagingEntry
from clara_coder_backend.state import current_session_id, get_session
from clara_coder_backend.tools.review_tools import read_staged_edit
from clara_coder_backend.tools.tool_conventions import clamp_line_window
from clara_coder_backend.tools.workspace import read_workspace_file


def test_clamp_line_window_normal_range_is_unchanged() -> None:
    assert clamp_line_window(1, 220, 220) == (1, 220)
    assert clamp_line_window(1, 5, 220) == (1, 5)
    assert clamp_line_window(281, 500, 220) == (281, 500)


def test_clamp_line_window_treats_stale_default_end_as_unspecified() -> None:
    # start_line=281 with the *default* end_line=220 (220 < 281): must not collapse to one entry.
    assert clamp_line_window(281, 220, 220) == (281, 500)


def test_clamp_line_window_respects_max_value_ceiling() -> None:
    assert clamp_line_window(305, 220, 220, max_value=310) == (305, 310)
    assert clamp_line_window(300, 220, 220, max_value=310) == (300, 310)


def test_read_workspace_file_pagination_past_default_end_line_reads_a_window(tmp_path) -> None:
    session_id = 'read-ws-pagination'
    token = current_session_id.set(session_id)
    try:
        root = tmp_path / 'ws'
        root.mkdir()
        session = get_session(session_id)
        session.workspace_path = str(root.resolve())
        content = ''.join(f'line {i}\n' for i in range(1, 301))
        (root / 'big.txt').write_text(content, encoding='utf-8')

        # Model continues pagination with only start_line set (no end_line)—must not return one line.
        out = read_workspace_file.invoke({'relative_path': 'big.txt', 'start_line': 281})
        assert 'Lines: 281-300' in out
        assert 'line 281' in out
        assert 'line 300' in out
    finally:
        current_session_id.reset(token)


def test_read_staged_edit_pagination_past_default_end_line_reads_a_window() -> None:
    session_id = 'read-staged-pagination'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.worker_apply_mode = True
    temp_path = None
    try:
        import tempfile

        content = ''.join(f'line {i}\n' for i in range(1, 301))
        with tempfile.NamedTemporaryFile('w', suffix='.txt', delete=False, encoding='utf-8') as fh:
            fh.write(content)
            temp_path = fh.name
        session.pending_edit_stagings['big.txt'] = EditStagingEntry(
            temp_path=temp_path,
            old_text='',
            merged_text=content,
            disk_encoding='utf-8',
            disk_newline='lf',
            edit_mode='full-file',
            workspace_applied=False,
        )

        out = read_staged_edit.invoke({'relative_path': 'big.txt', 'start_line': 281})
        # The staged-edit header reports the requested (clamped) window rather than the actual excerpt
        # length, but the body must contain the full run of lines through the end of the file—not just
        # the single line 281 the pre-fix collapse would have returned.
        for i in range(281, 301):
            assert f'line {i}' in out
    finally:
        session.pending_edit_stagings.clear()
        current_session_id.reset(token)
        if temp_path:
            import os

            os.unlink(temp_path)
