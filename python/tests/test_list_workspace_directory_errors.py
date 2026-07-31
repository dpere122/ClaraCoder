"""list_workspace_directory should return guidance instead of raising when the path is wrong."""

from clara_coder_backend.state import current_session_id, get_session
from clara_coder_backend.tools.workspace import list_workspace_directory


def test_list_workspace_directory_missing_returns_string_not_raise(tmp_path) -> None:
    session_id = 'list-ws-missing'
    token = current_session_id.set(session_id)
    try:
        root = tmp_path / 'ws'
        root.mkdir()
        session = get_session(session_id)
        session.workspace_path = str(root.resolve())
        out = list_workspace_directory.invoke({'relative_path': 'electron'})
        assert isinstance(out, str)
        assert 'electron' in out
        assert 'Tool note:' in out
        assert 'search_workspace' in out
    finally:
        current_session_id.reset(token)


def test_list_workspace_directory_file_returns_string_not_raise(tmp_path) -> None:
    session_id = 'list-ws-file'
    token = current_session_id.set(session_id)
    try:
        root = tmp_path / 'ws'
        root.mkdir()
        (root / 'package.json').write_text('{}', encoding='utf-8')
        session = get_session(session_id)
        session.workspace_path = str(root.resolve())
        out = list_workspace_directory.invoke({'relative_path': 'package.json'})
        assert isinstance(out, str)
        assert 'package.json' in out
        assert 'read_workspace_file' in out
    finally:
        current_session_id.reset(token)
