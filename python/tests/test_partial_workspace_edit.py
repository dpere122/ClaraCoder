"""Tests for partial workspace edit merge."""

from nemo_backend.partial_workspace_edit import merge_partial_edit


def test_full_file() -> None:
    out, err = merge_partial_edit('a', new_content='b', old_snippet='', new_snippet='', start_line=0, end_line=0)
    assert err is None
    assert out == 'b'


def test_line_range() -> None:
    old = 'l1\nl2\nl3\n'
    out, err = merge_partial_edit(
        old,
        new_content='',
        old_snippet='',
        new_snippet='x',
        start_line=2,
        end_line=2,
    )
    assert err is None
    assert out == 'l1\nx\nl3\n'


def test_line_range_append_after_last_line() -> None:
    old = 'l1\nl2\n'
    out, err = merge_partial_edit(
        old,
        new_content='',
        old_snippet='',
        new_snippet='l3\nl4\n',
        start_line=3,
        end_line=3,
    )
    assert err is None
    assert out == 'l1\nl2\nl3\nl4\n'


def test_line_range_seeds_empty_file() -> None:
    out, err = merge_partial_edit(
        '',
        new_content='',
        old_snippet='',
        new_snippet='seeded\n',
        start_line=1,
        end_line=1,
    )
    assert err is None
    assert out == 'seeded\n'


def test_snippet_patch() -> None:
    old = 'before\nOLD\nafter\n'
    out, err = merge_partial_edit(
        old,
        new_content='',
        old_snippet='OLD',
        new_snippet='NEW',
        start_line=0,
        end_line=0,
    )
    assert err is None
    assert out == 'before\nNEW\nafter\n'


def test_line_mode_priority_over_full() -> None:
    old = 'a\nb\n'
    out, err = merge_partial_edit(
        old,
        new_content='SHOULD_NOT_USE',
        old_snippet='',
        new_snippet='z',
        start_line=1,
        end_line=1,
    )
    assert err is None
    assert out == 'z\nb\n'


def test_strip_numbered_read_prefixes() -> None:
    old = 'def foo():\n    return 1\n'
    snippet = '1: def foo():\n2:     return 1'
    out, err = merge_partial_edit(
        old,
        new_content='',
        old_snippet=snippet,
        new_snippet='def foo():\n    return 2',
        start_line=0,
        end_line=0,
    )
    assert err is None
    assert out == 'def foo():\n    return 2\n'


def test_strip_numbered_preserves_trailing_newline() -> None:
    old = 'a\n'
    out, err = merge_partial_edit(
        old,
        new_content='',
        old_snippet='1: a\n',
        new_snippet='b\n',
        start_line=0,
        end_line=0,
    )
    assert err is None
    assert out == 'b\n'


def test_strip_unicode_gutter_separator() -> None:
    old = 'def foo():\n    return 1\n'
    snippet = '  1 │ def foo():\n  2 │     return 1'
    out, err = merge_partial_edit(
        old,
        new_content='',
        old_snippet=snippet,
        new_snippet='def foo():\n    return 2',
        start_line=0,
        end_line=0,
    )
    assert err is None
    assert out == 'def foo():\n    return 2\n'


def test_strip_gutter_pipe_format() -> None:
    old = 'def foo():\n    return 1\n'
    snippet = '1 | def foo():\n2 |     return 1'
    out, err = merge_partial_edit(
        old,
        new_content='',
        old_snippet=snippet,
        new_snippet='def foo():\n    return 2',
        start_line=0,
        end_line=0,
    )
    assert err is None
    assert out == 'def foo():\n    return 2\n'


def test_strip_gutter_padded_width() -> None:
    old = '\n'.join(['x'] * 12) + '\n'
    snippet = '\n'.join(f'{i:>2} | x' for i in range(1, 13)) + '\n'
    out, err = merge_partial_edit(
        old,
        new_content='',
        old_snippet=snippet,
        new_snippet='y\n',
        start_line=0,
        end_line=0,
    )
    assert err is None
    assert out == 'y\n'


def test_mixed_numbered_and_plain_no_strip() -> None:
    old = 'only\n'
    out, err = merge_partial_edit(
        old,
        new_content='',
        old_snippet='1: only\nno prefix here',
        new_snippet='x',
        start_line=0,
        end_line=0,
    )
    assert err is not None


def test_crlf_relaxed_exact() -> None:
    old = 'alpha\r\nbeta\r\n'
    out, err = merge_partial_edit(
        old,
        new_content='',
        old_snippet='alpha\nbeta',
        new_snippet='A\nB',
        start_line=0,
        end_line=0,
    )
    assert err is None
    assert out == 'A\nB\r\n'


def test_ambiguous_snippet_error() -> None:
    old = 'x\nx\n'
    out, err = merge_partial_edit(
        old,
        new_content='',
        old_snippet='x',
        new_snippet='y',
        start_line=0,
        end_line=0,
    )
    assert out is None
    assert err is not None
    assert 'appears 2 times' in err


def test_snippet_not_found() -> None:
    old = 'abc\n'
    out, err = merge_partial_edit(
        old,
        new_content='',
        old_snippet='zzz_not_present',
        new_snippet='q',
        start_line=0,
        end_line=0,
    )
    assert out is None
    assert err is not None


def test_line_range_past_end_error_suggests_append() -> None:
    out, err = merge_partial_edit(
        '',
        new_content='',
        old_snippet='',
        new_snippet='x\n',
        start_line=2,
        end_line=2,
    )
    assert out is None
    assert err is not None
    assert 'append after the last line' in err
    assert 'start_line=end_line=1' in err
