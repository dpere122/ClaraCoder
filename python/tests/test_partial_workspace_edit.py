"""Tests for partial workspace edit merge."""

import unittest

from nemo_backend.partial_workspace_edit import merge_partial_edit


class TestPartialWorkspaceEdit(unittest.TestCase):
    def test_full_file(self) -> None:
        out, err = merge_partial_edit('a', new_content='b', old_snippet='', new_snippet='', start_line=0, end_line=0)
        self.assertIsNone(err)
        self.assertEqual(out, 'b')

    def test_line_range(self) -> None:
        old = 'l1\nl2\nl3\n'
        out, err = merge_partial_edit(
            old,
            new_content='',
            old_snippet='',
            new_snippet='x',
            start_line=2,
            end_line=2,
        )
        self.assertIsNone(err)
        self.assertEqual(out, 'l1\nx\nl3\n')

    def test_snippet_patch(self) -> None:
        old = 'before\nOLD\nafter\n'
        out, err = merge_partial_edit(
            old,
            new_content='',
            old_snippet='OLD',
            new_snippet='NEW',
            start_line=0,
            end_line=0,
        )
        self.assertIsNone(err)
        self.assertEqual(out, 'before\nNEW\nafter\n')

    def test_line_mode_priority_over_full(self) -> None:
        old = 'a\nb\n'
        out, err = merge_partial_edit(
            old,
            new_content='SHOULD_NOT_USE',
            old_snippet='',
            new_snippet='z',
            start_line=1,
            end_line=1,
        )
        self.assertIsNone(err)
        self.assertEqual(out, 'z\nb\n')

    def test_strip_numbered_read_prefixes(self) -> None:
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
        self.assertIsNone(err)
        self.assertEqual(out, 'def foo():\n    return 2\n')

    def test_strip_numbered_preserves_trailing_newline(self) -> None:
        old = 'a\n'
        out, err = merge_partial_edit(
            old,
            new_content='',
            old_snippet='1: a\n',
            new_snippet='b\n',
            start_line=0,
            end_line=0,
        )
        self.assertIsNone(err)
        self.assertEqual(out, 'b\n')

    def test_mixed_numbered_and_plain_no_strip(self) -> None:
        old = 'only\n'
        out, err = merge_partial_edit(
            old,
            new_content='',
            old_snippet='1: only\nno prefix here',
            new_snippet='x',
            start_line=0,
            end_line=0,
        )
        self.assertIsNotNone(err)

    def test_crlf_relaxed_exact(self) -> None:
        old = 'alpha\r\nbeta\r\n'
        out, err = merge_partial_edit(
            old,
            new_content='',
            old_snippet='alpha\nbeta',
            new_snippet='A\nB',
            start_line=0,
            end_line=0,
        )
        self.assertIsNone(err)
        self.assertEqual(out, 'A\nB\r\n')

    def test_ambiguous_snippet_error(self) -> None:
        old = 'x\nx\n'
        out, err = merge_partial_edit(
            old,
            new_content='',
            old_snippet='x',
            new_snippet='y',
            start_line=0,
            end_line=0,
        )
        self.assertIsNone(out)
        self.assertIsNotNone(err)
        assert err is not None
        self.assertIn('appears 2 times', err)

    def test_snippet_not_found(self) -> None:
        old = 'abc\n'
        out, err = merge_partial_edit(
            old,
            new_content='',
            old_snippet='zzz_not_present',
            new_snippet='q',
            start_line=0,
            end_line=0,
        )
        self.assertIsNone(out)
        self.assertIsNotNone(err)


if __name__ == '__main__':
    unittest.main()
