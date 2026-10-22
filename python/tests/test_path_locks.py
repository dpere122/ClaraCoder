"""Per-batch line maps that move a line-range edit past earlier edits of the same file in one response."""

from __future__ import annotations

import sys
import threading

from clara_coder_backend.domain import SessionState
from clara_coder_backend.session.file_journal import first_mutation_this_turn
from clara_coder_backend.session.state import current_session_id, current_tool_batch_id
from clara_coder_backend.workspace.path_locks import (
    BatchLineMap,
    batch_line_map,
    note_batch_replaced,
    note_batch_write,
)


def test_lines_after_an_insert_shift_down() -> None:
    m = BatchLineMap('a\nb\nc\n')
    m.apply_write('a\nb\nc\n', 'zero\na\nb\nc\n')
    assert m.map_range(2, 3) == (3, 4)
    assert m.map_range(1, 1) == (2, 2)


def test_lines_before_a_change_stay_put() -> None:
    m = BatchLineMap('a\nb\nc\n')
    m.apply_write('a\nb\nc\n', 'a\nb\nC\nD\n')
    assert m.map_range(1, 2) == (1, 2)


def test_changed_lines_refuse() -> None:
    m = BatchLineMap('a\nb\nc\nd\n')
    m.apply_write('a\nb\nc\nd\n', 'a\nB\nc\nd\n')
    assert m.map_range(2, 2) is None
    assert m.map_range(1, 3) is None
    assert m.map_range(3, 4) == (3, 4)


def test_an_insert_inside_the_range_refuses() -> None:
    m = BatchLineMap('a\nb\nc\n')
    m.apply_write('a\nb\nc\n', 'a\nb\nNEW\nc\n')
    assert m.map_range(2, 3) is None
    assert m.map_range(3, 3) == (4, 4)


def test_deleted_lines_shift_the_rest_up() -> None:
    m = BatchLineMap('a\nb\nc\nd\n')
    m.apply_write('a\nb\nc\nd\n', 'a\nd\n')
    assert m.map_range(2, 3) is None
    assert m.map_range(4, 4) == (2, 2)


def test_maps_compose_across_writes() -> None:
    m = BatchLineMap('1\n2\n3\n4\n5\n')
    m.apply_write('1\n2\n3\n4\n5\n', '0\n1\n2\n3\n4\n5\n')
    m.apply_write('0\n1\n2\n3\n4\n5\n', '0\n1\n2\n3\n5\n')
    assert m.map_range(5, 5) == (5, 5)
    assert m.map_range(4, 4) is None
    assert m.map_range(1, 3) == (2, 4)


def test_append_goes_after_the_current_last_line() -> None:
    m = BatchLineMap('a\nb\n')
    m.apply_write('a\nb\n', 'a\nb\nc\n')
    assert m.map_range(3, 3) == (4, 4)
    # Base lines past the base end are lines another call appended, not ones the caller read.
    m2 = BatchLineMap('a\nb\n')
    m2.apply_write('a\nb\n', 'a\nb\nc\nd\n')
    assert m2.map_range(3, 4) is None


def test_replaced_file_refuses_every_range() -> None:
    m = BatchLineMap('a\nb\n')
    m.replace_all()
    assert m.map_range(1, 1) is None
    assert m.map_range(3, 3) is None


def test_maps_are_scoped_to_session_and_batch() -> None:
    s_token = current_session_id.set('session-a')
    b_token = current_tool_batch_id.set('batch-1')
    try:
        note_batch_write('k', 'a\n', 'z\na\n')
        assert batch_line_map('k') is not None
        current_session_id.set('session-b')
        assert batch_line_map('k') is None
        current_session_id.set('session-a')
        current_tool_batch_id.set('batch-2')
        assert batch_line_map('k') is None
    finally:
        current_tool_batch_id.reset(b_token)
        current_session_id.reset(s_token)


def test_no_batch_records_nothing() -> None:
    token = current_tool_batch_id.set('')
    try:
        note_batch_write('k-none', 'a\n', 'b\n')
        note_batch_replaced('k-none')
        assert batch_line_map('k-none') is None
    finally:
        current_tool_batch_id.reset(token)


def test_parallel_first_mutations_of_a_new_turn_journal_each_path_once() -> None:
    """The turn switch and the set update run under one lock, so no thread loses another's path."""
    old_interval = sys.getswitchinterval()
    sys.setswitchinterval(1e-6)
    try:
        for attempt in range(100):
            session = SessionState()
            session.edits.journal_turn_id = 'old-turn'
            session.current_user_message_id = f'turn-{attempt}'
            firsts: list[str] = []
            barrier = threading.Barrier(8)

            def journal(i: int) -> None:
                barrier.wait()
                for path in (f'f{i}.txt', 'shared.txt'):
                    if first_mutation_this_turn(session, path):
                        firsts.append(path)

            threads = [threading.Thread(target=journal, args=(i,)) for i in range(8)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

            assert sorted(firsts) == sorted([f'f{i}.txt' for i in range(8)] + ['shared.txt'])
            assert session.edits.journaled_paths == set(firsts)
            assert session.edits.journal_earlier_turns == {'old-turn': set()}
    finally:
        sys.setswitchinterval(old_interval)
