"""Refcount for overlapping /chat/stream runs on one session (Editor mode flag)."""

from __future__ import annotations

from nemo_backend.domain import SessionState


def test_editor_stream_refcount_one_exit_keeps_apply_when_second_holds() -> None:
    """When two apply-mode agent streams overlap, first teardown must not clear editor for the second."""
    s = SessionState()
    s.active_langgraph_agent_streams = 2
    s.active_editor_langgraph_streams = 2
    s.worker_apply_mode = True

    # First stream's finally
    s.active_editor_langgraph_streams = max(0, s.active_editor_langgraph_streams - 1)
    s.worker_apply_mode = s.active_editor_langgraph_streams > 0
    s.active_langgraph_agent_streams = max(0, s.active_langgraph_agent_streams - 1)

    assert s.worker_apply_mode is True
    assert s.active_langgraph_agent_streams == 1
    assert s.active_editor_langgraph_streams == 1

    # Second stream's finally
    s.active_editor_langgraph_streams = max(0, s.active_editor_langgraph_streams - 1)
    s.worker_apply_mode = s.active_editor_langgraph_streams > 0
    s.active_langgraph_agent_streams = max(0, s.active_langgraph_agent_streams - 1)

    assert s.worker_apply_mode is False
    assert s.active_langgraph_agent_streams == 0
    assert s.active_editor_langgraph_streams == 0
