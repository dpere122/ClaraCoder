"""Tests for Rust LSP read tools: descriptions, error formatting, and end-to-end reads."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from clara_coder_backend.domain import RuntimeToolsConfig
from clara_coder_backend.lsp.plugins.rust_plugin import UNTRUSTED_MESSAGE
from clara_coder_backend.lsp.server_plugin import LspServerNotInstalledError
from clara_coder_backend.session.state import current_session_id, get_session, runtime_config
from clara_coder_backend.tools.lsp_tools import (
    LSP_READ_TOOLS,
    LSP_WORKSPACE_SYMBOLS_NAME,
    _format_lsp_tool_error,
    lsp_find_definition,
    lsp_get_diagnostics,
    lsp_get_document_symbols,
    lsp_hover,
    lsp_type_hierarchy,
)


class _FakeRustManager:
    """Fake manager exposing the methods the LSP read tools call on a Rust workspace."""

    def __init__(self, workspace_root: Path, server: str) -> None:
        self.workspace_root = workspace_root
        self.server = server
        self.sync_calls: list[str] = []

    def sync_for_agent(self, relative_path: str, **kwargs: Any) -> list[dict[str, object]]:
        self.sync_calls.append(relative_path)
        return []

    def hover(self, relative_path: str, line: int, character: int) -> dict[str, object]:
        del relative_path, line, character
        return {'contents': 'fn main() -> i32'}

    def definition(self, relative_path: str, line: int, character: int) -> list[dict[str, object]]:
        del line, character
        uri = (self.workspace_root / relative_path).resolve().as_uri()
        return [{'uri': uri, 'range': {'start': {'line': 0, 'character': 4}}}]

    def references(self, relative_path: str, line: int, character: int, include_declaration: bool = False) -> list[dict[str, object]]:
        del line, character, include_declaration
        uri = (self.workspace_root / relative_path).resolve().as_uri()
        return [{'uri': uri, 'range': {'start': {'line': 0, 'character': 0}}}]

    def document_symbols(self, relative_path: str) -> list[dict[str, object]]:
        del relative_path
        return [
            {
                'name': 'main',
                'kind': 12,
                'range': {'start': {'line': 0, 'character': 0}},
                'selectionRange': {'start': {'line': 0, 'character': 4}},
                'children': [],
            }
        ]

    def has_provider(self, provider: str) -> bool:
        return provider != 'typeHierarchyProvider'

    def mark_diagnostics_stale(self, relative_path: str) -> None:
        del relative_path

    def document_version(self, relative_path: str) -> int:
        del relative_path
        return 1

    def get_diagnostics(self, relative_path: str) -> list[dict[str, object]]:
        del relative_path
        return []

    def diagnostics_off_reason(self, relative_path: str) -> str | None:
        del relative_path
        return None

    def diagnostics_fresh(self, relative_path: str) -> bool:
        del relative_path
        return True


@pytest.fixture(autouse=True)
def _reset_tools_config():
    saved = runtime_config.tools
    runtime_config.tools = RuntimeToolsConfig(edit_tools_strict=False)
    yield
    runtime_config.tools = saved


@pytest.fixture()
def rust_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    workspace = tmp_path / 'ws'
    (workspace / 'src').mkdir(parents=True)
    (workspace / 'src' / 'main.rs').write_text('fn main() {}\n', encoding='utf-8')

    session_id = 'rust-lsp-tools-session'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.workspace_path = str(workspace.resolve())

    manager = _FakeRustManager(workspace.resolve(), 'rust')
    requested_servers: list[str] = []

    def _fake_get_session_lsp_manager(*args: Any, **kwargs: Any) -> _FakeRustManager:
        del args
        requested_servers.append(str(kwargs.get('server')))
        return manager

    monkeypatch.setattr('clara_coder_backend.tools.lsp_tools.get_session_lsp_manager', _fake_get_session_lsp_manager)

    class _Env:
        pass

    env = _Env()
    env.session_id = session_id  # type: ignore[attr-defined]
    env.session = session  # type: ignore[attr-defined]
    env.workspace = workspace  # type: ignore[attr-defined]
    env.manager = manager  # type: ignore[attr-defined]
    env.requested_servers = requested_servers  # type: ignore[attr-defined]
    yield env
    current_session_id.reset(token)


# --- (a) descriptions mention `.rs`


def test_all_path_tools_mention_rust_extension() -> None:
    for tool in LSP_READ_TOOLS:
        if tool.name == LSP_WORKSPACE_SYMBOLS_NAME:
            continue
        assert '`.rs`' in tool.description, f'{tool.name} description missing `.rs`'


# --- (b) unsupported extension error lists `.rs`


def test_unsupported_extension_error_lists_rust() -> None:
    result = lsp_hover.invoke({'relative_path': 'notes.txt', 'line': 1, 'character': 1})
    assert 'Tool error:' in result
    assert '`.rs`' in result


# --- (c) _format_lsp_tool_error


def test_rust_closed_client_hint() -> None:
    exc = RuntimeError("LSP request failed for 'initialize': LSP client closed")
    msg = _format_lsp_tool_error('hover lookup', exc, relative_path='src/main.rs', server='rust')
    assert msg.startswith('Tool error: Rust LSP hover lookup failed for `src/main.rs`')
    assert 'rust-analyzer' in msg
    assert 'cargo' in msg
    assert 'trusted' in msg
    assert 'Node' not in msg


def test_rust_untrusted_message_has_no_extra_hint() -> None:
    exc = LspServerNotInstalledError(UNTRUSTED_MESSAGE)
    msg = _format_lsp_tool_error('hover lookup', exc, relative_path='src/main.rs', server='rust')
    assert msg.startswith('Tool error: Rust LSP hover lookup failed for `src/main.rs`')
    assert 'The backend could not start' not in msg


def test_python_still_gets_node_python_hint() -> None:
    exc = RuntimeError("LSP request failed for 'initialize': LSP client closed")
    msg = _format_lsp_tool_error('hover lookup', exc, relative_path='pkg/mod.py', server='python')
    assert 'check Node for TS/JS or Python env for .py' in msg


# --- (d) end-to-end reads on a `.rs` file


def test_rust_hover(rust_env) -> None:
    hover_text = lsp_hover.invoke({'relative_path': 'src/main.rs', 'line': 1, 'character': 1})
    assert 'fn main() -> i32' in hover_text
    assert 'src/main.rs' in hover_text
    assert rust_env.manager.sync_calls == ['src/main.rs']
    assert rust_env.requested_servers == ['rust']


def test_rust_definition(rust_env) -> None:
    def_text = lsp_find_definition.invoke({'relative_path': 'src/main.rs', 'line': 1, 'character': 1})
    assert 'src/main.rs' in def_text
    assert '1:5' in def_text


def test_rust_document_symbols(rust_env) -> None:
    sym_text = lsp_get_document_symbols.invoke({'relative_path': 'src/main.rs'})
    assert 'main (kind=12, line=1)' in sym_text
    assert 'src/main.rs' in sym_text


def test_rust_diagnostics(rust_env) -> None:
    diag_text = lsp_get_diagnostics.invoke({'relative_path': 'src/main.rs'})
    assert 'src/main.rs' in diag_text
    assert 'LSP context:' in diag_text
    assert 'No LSP diagnostics for `src/main.rs`' in diag_text


def test_rust_type_hierarchy_not_supported(rust_env, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        'clara_coder_backend.tools.lsp_tools.run_editor_feature',
        lambda manager, rel, feature, params: {'locations': []},
    )
    result = lsp_type_hierarchy.invoke({'relative_path': 'src/main.rs', 'line': 1, 'character': 1})
    assert 'does not support this lookup' in result
