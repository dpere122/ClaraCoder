"""Tests for diff payload build and verify behavior."""

import unittest
from unittest.mock import MagicMock, patch

from nemo_backend.diff_payload import build_file_diff_payload


class TestDiffPayload(unittest.TestCase):
    def test_builds_small_change(self) -> None:
        payload, err = build_file_diff_payload('a.ts', 'one\ntwo\n', 'one\nTWO\n')
        self.assertIsNone(err)
        self.assertIsNotNone(payload)
        assert payload is not None
        self.assertEqual(payload['fullNewContent'], 'one\nTWO\n')
        kinds = [r['kind'] for r in payload['rows']]
        self.assertEqual(kinds, ['equal', 'replace'])

    def test_repeated_context_lines_middle_replace(self) -> None:
        """Line-mode DMP + cleanup keeps a single replace row when editing the middle of repeated lines."""
        old = 'a\na\na\n'
        new = 'a\nb\na\n'
        payload, err = build_file_diff_payload('x.txt', old, new)
        self.assertIsNone(err)
        assert payload is not None
        self.assertEqual([r['kind'] for r in payload['rows']], ['equal', 'replace', 'equal'])

    @patch('nemo_backend.diff_payload._verify_patch', return_value=False)
    def test_builds_when_patch_verify_fails(self, _mock_verify: MagicMock) -> None:
        payload, err = build_file_diff_payload('a.ts', 'x\n', 'y\n')
        self.assertIsNone(err)
        self.assertIsNotNone(payload)
        assert payload is not None
        self.assertEqual(payload['fullNewContent'], 'y\n')

    @patch('nemo_backend.diff_payload.DIFF_VERIFY_PATCH_MAX_BYTES', 8)
    def test_skips_verify_when_over_byte_limit(self) -> None:
        old = 'a' * 20
        new = 'b' * 20
        payload, err = build_file_diff_payload('big.txt', old, new)
        self.assertIsNone(err)
        self.assertIsNotNone(payload)
        assert payload is not None
        self.assertEqual(payload['fullNewContent'], new)


if __name__ == '__main__':
    unittest.main()
