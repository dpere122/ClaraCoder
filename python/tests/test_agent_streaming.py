"""Unit tests for SSE streaming helpers."""

import unittest

from langchain_core.messages import AIMessageChunk

from nemo_backend.agent_streaming import aimessage_chunk_sse_delta


class TestAimessageChunkSseDelta(unittest.TestCase):
    def test_empty(self) -> None:
        self.assertEqual(aimessage_chunk_sse_delta(AIMessageChunk(content='')), '')

    def test_text(self) -> None:
        self.assertEqual(aimessage_chunk_sse_delta(AIMessageChunk(content='hello')), 'hello')


if __name__ == '__main__':
    unittest.main()
