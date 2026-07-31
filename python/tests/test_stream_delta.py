"""Stream delta filtering for SSE chunks."""

from clara_coder_backend.lang_agent.streaming import is_meaningful_stream_delta


def test_newline_only_chunks_preserved() -> None:
    assert is_meaningful_stream_delta('\n')
    assert is_meaningful_stream_delta('\n\n')


def test_space_only_dropped() -> None:
    assert not is_meaningful_stream_delta('')
    assert not is_meaningful_stream_delta('   ')
    assert not is_meaningful_stream_delta('\t')


def test_visible_text() -> None:
    assert is_meaningful_stream_delta('Hello')
    assert is_meaningful_stream_delta('a\nb')
