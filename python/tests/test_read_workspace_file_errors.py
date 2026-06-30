"""read_workspace_file should return guidance instead of raising when the path is wrong."""

from nemo_backend.state import current_session_id, get_session
from nemo_backend.tools.workspace import read_workspace_file


def test_read_workspace_file_missing_returns_string_not_raise(tmp_path) -> None:
    session_id = 'read-ws-missing'
    token = current_session_id.set(session_id)
    try:
        root = tmp_path / 'ws'
        root.mkdir()
        session = get_session(session_id)
        session.workspace_path = str(root.resolve())
        out = read_workspace_file.invoke({'relative_path': 'main.py'})
        assert isinstance(out, str)
        assert 'main.py' in out
        assert 'list_staged_edits' in out
        assert 'read_staged_edit' in out
        assert 'transfer_staged_file_to_workspace' in out
    finally:
        current_session_id.reset(token)


def test_read_workspace_file_directory_returns_string_not_raise(tmp_path) -> None:
    session_id = 'read-ws-dir'
    token = current_session_id.set(session_id)
    try:
        root = tmp_path / 'ws'
        root.mkdir()
        (root / 'pkg').mkdir()
        session = get_session(session_id)
        session.workspace_path = str(root.resolve())
        out = read_workspace_file.invoke({'relative_path': 'pkg'})
        assert isinstance(out, str)
        assert 'pkg' in out
        assert 'list_workspace_directory' in out
    finally:
        current_session_id.reset(token)
