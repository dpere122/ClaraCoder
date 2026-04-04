"""Stream delta filtering for SSE chunks."""

import unittest

from nemo_backend.agent_streaming import is_meaningful_stream_delta


class TestStreamDelta(unittest.TestCase):
    def test_newline_only_chunks_preserved(self) -> None:
        self.assertTrue(is_meaningful_stream_delta('\n'))
        self.assertTrue(is_meaningful_stream_delta('\n\n'))

    def test_space_only_dropped(self) -> None:
        self.assertFalse(is_meaningful_stream_delta(''))
        self.assertFalse(is_meaningful_stream_delta('   '))
        self.assertFalse(is_meaningful_stream_delta('\t'))

    def test_visible_text(self) -> None:
        self.assertTrue(is_meaningful_stream_delta('Hello'))
        self.assertTrue(is_meaningful_stream_delta('a\nb'))


if __name__ == '__main__':
    unittest.main()
