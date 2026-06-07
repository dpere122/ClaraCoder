"""Tests for Gemma 4 ``<|channel>`` output parsing."""

from nemo_backend.gemma_output import GemmaStreamSplitter, split_gemma_channels


def test_split_thought_then_answer() -> None:
    raw = "<|channel>thought\nI'm\nthinking<channel|>Hello, world!"
    visible, reasoning = split_gemma_channels(raw)
    assert reasoning == "I'm\nthinking"
    assert visible == "Hello, world!"


def test_split_interleaved_thought_and_tool_call() -> None:
    raw = (
        "<|channel>thought\nplanning<channel|>"
        "<|tool_call>call:read_workspace_file{path:<|\"|>a.py<|\"|>} "
        "done"
    )
    visible, reasoning = split_gemma_channels(raw)
    assert reasoning == "planning"
    assert "<|tool_call>" in visible
    assert "done" in visible


def test_split_empty_thought_block() -> None:
    raw = "<|channel>thought\n<channel|>Answer only."
    visible, reasoning = split_gemma_channels(raw)
    assert reasoning == ""
    assert visible == "Answer only."


def test_split_strips_turn_tokens() -> None:
    raw = "<|turn>model\n<|channel>thought\nx<channel|>hi"
    visible, reasoning = split_gemma_channels(raw)
    assert reasoning == "x"
    assert visible == "hi"
    assert "<|turn>" not in visible


def test_split_passthrough_without_markers() -> None:
    assert split_gemma_channels("plain answer") == ("plain answer", "")


def test_stream_splitter_incremental() -> None:
    splitter = GemmaStreamSplitter()
    main, reason = splitter.feed("<|channel>thought\nstep")
    assert main == ""
    assert reason == "step"
    main2, reason2 = splitter.feed(" one<channel|>Hi")
    assert main2 == "Hi"
    assert reason2 == " one"
    assert splitter.flush() == ("", "")


def test_stream_splitter_emits_open_channel_before_close() -> None:
    splitter = GemmaStreamSplitter()
    _, reason = splitter.feed("<|channel>thought\ntail")
    assert reason == "tail"
    assert splitter.flush() == ("", "")
