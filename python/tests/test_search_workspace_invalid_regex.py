"""Invalid regex queries must return a Tool error string, not abort the agent turn.

Regression for: model searched ``ipcMain.on("save-content"`` (unclosed ``(``), which raised
``re.PatternError`` and killed the LangGraph run instead of surfacing a recoverable tool result.
"""

from __future__ import annotations

from clara_coder_backend.state import current_session_id, get_session
from clara_coder_backend.tools.workspace import search_workspace


def test_search_workspace_invalid_regex_returns_tool_error_not_raise(tmp_path) -> None:
    session_id = 'search-ws-bad-regex'
    token = current_session_id.set(session_id)
    try:
        root = tmp_path / 'ws'
        root.mkdir()
        (root / 'main.ts').write_text('ipcMain.on("save-content", () => {})\n', encoding='utf-8')
        session = get_session(session_id)
        session.workspace_path = str(root.resolve())

        # Exact failing query from the live session log (unterminated subpattern at position 10).
        out = search_workspace.invoke({'query': 'ipcMain.on("save-content"'})
        assert isinstance(out, str)
        assert out.startswith('Tool error: invalid regex:')
        assert 'unterminated subpattern' in out or 'missing )' in out
        assert 'escape regex' in out.lower() or 'metacharacters' in out.lower()
    finally:
        current_session_id.reset(token)


def test_search_workspace_valid_literal_still_works(tmp_path) -> None:
    session_id = 'search-ws-ok'
    token = current_session_id.set(session_id)
    try:
        root = tmp_path / 'ws'
        root.mkdir()
        (root / 'main.ts').write_text('ipcMain.on("save-content", () => {})\n', encoding='utf-8')
        session = get_session(session_id)
        session.workspace_path = str(root.resolve())

        out = search_workspace.invoke({'query': 'save-content'})
        assert 'main.ts' in out
        assert 'save-content' in out
    finally:
        current_session_id.reset(token)
