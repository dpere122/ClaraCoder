"""Unit tests for LangGraph outer-agent helpers."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from nemo_backend.agent_langgraph import _cleanup_nested_edit_staging
from nemo_backend.domain import SessionState


@patch('nemo_backend.agent_langgraph.clear_session_staging_dir')
@patch('nemo_backend.agent_langgraph.discard_all_session_stagings')
def test_cleanup_nested_edit_staging_discards_pending_entries(
    mock_discard: MagicMock, mock_clear_dir: MagicMock
) -> None:
    session = SessionState()
    session.pending_edit_stagings = {'foo.py': MagicMock()}

    _cleanup_nested_edit_staging(session, 'sess-1')

    mock_discard.assert_called_once_with(session)
    mock_clear_dir.assert_called_once_with('sess-1')


@patch('nemo_backend.agent_langgraph.clear_session_staging_dir')
@patch('nemo_backend.agent_langgraph.discard_all_session_stagings')
def test_cleanup_nested_edit_staging_still_clears_session_dir_without_entries(
    mock_discard: MagicMock, mock_clear_dir: MagicMock
) -> None:
    session = SessionState()

    _cleanup_nested_edit_staging(session, 'sess-1')

    mock_discard.assert_not_called()
    mock_clear_dir.assert_called_once_with('sess-1')
