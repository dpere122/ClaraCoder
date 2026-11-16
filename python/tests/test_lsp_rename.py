"""Tests for the ``lsp_rename_symbol`` tool: pure edit helpers and the end-to-end rename path."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from clara_coder_backend.hitl.tool_registry import subagent_tool_group, worker_tools_and_map
from clara_coder_backend.tools import edit as edit_module
from clara_coder_backend.tools import lsp_rename as rename_module
from clara_coder_backend.tools.lsp_rename import (
    StaleEditError,
    apply_lsp_text_edits,
    lsp_rename_symbol,
    symbol_column,
)

_A = 'pkg/a.py'
_B = 'pkg/b.py'
_A_TEXT = 'def foo():\n    return 1\n'
_B_TEXT = 'from pkg.a import foo\n\nfoo()\n'


class _FakeManager:
    """Fake LSP manager: records calls, returns a configurable rename answer and diagnostics."""

    #: A server that reports readiness short-circuits the workspace-analysis wait, so no "still analyzing" note.
    reports_readiness = True

    def __init__(self, *, has_provider: bool = True, rename_result: Any = None, diagnostics: dict[str, list[dict]] | None = None) -> None:
        self._has_provider = has_provider
        self._rename_result = rename_result
        self._diagnostics = diagnostics or {}
        self.sync_calls: list[tuple[str, dict[str, Any]]] = []
        self.rename_calls: list[tuple[str, int, int, str]] = []

    def sync_for_agent(self, rel: str, encoding: str = 'utf-8') -> list[dict[str, Any]]:
        self.sync_calls.append((rel, {'encoding': encoding}))
        return []

    def has_provider(self, name: str) -> bool:
        return self._has_provider

    def rename(self, rel: str, line: int, character: int, new_name: str) -> Any:
        self.rename_calls.append((rel, line, character, new_name))
        return self._rename_result

    def get_diagnostics(self, rel: str) -> list[dict[str, Any]]:
        return self._diagnostics.get(rel, [])


@pytest.fixture()
def env(workspace_env, monkeypatch: pytest.MonkeyPatch):
    """Editor-mode temp workspace with the language server faked out in the rename module."""
    manager = _FakeManager()
    servers: list[str] = []
    sync_calls: list[tuple[str, dict[str, Any]]] = []
    journal_paths: list[str] = []

    def _fake_agent_manager(server: str) -> _FakeManager:
        servers.append(server)
        return manager

    def _fake_sync(relative_path: str, text: str, **kwargs: Any) -> list[dict[str, Any]]:
        sync_calls.append((relative_path, dict(kwargs)))
        return []

    def _fake_journal(session: Any, relative_path: str, *args: Any, **kwargs: Any) -> None:
        journal_paths.append(relative_path)

    monkeypatch.setattr(rename_module, '_agent_manager', _fake_agent_manager)
    monkeypatch.setattr(rename_module, 'sync_session_document', _fake_sync)
    monkeypatch.setattr(rename_module, 'session_diagnostics_fresh', lambda *a, **k: True)
    monkeypatch.setattr(edit_module, 'emit_edit_journal', _fake_journal)

    class _Env:
        pass

    e = _Env()
    e.workspace = workspace_env.workspace  # type: ignore[attr-defined]
    e.session = workspace_env.session  # type: ignore[attr-defined]
    e.manager = manager  # type: ignore[attr-defined]
    e.servers = servers  # type: ignore[attr-defined]
    e.sync_calls = sync_calls  # type: ignore[attr-defined]
    e.journal_paths = journal_paths  # type: ignore[attr-defined]
    return e


def _edit(start_line: int, start_char: int, end_line: int, end_char: int, new_text: str) -> dict[str, Any]:
    return {
        'range': {
            'start': {'line': start_line, 'character': start_char},
            'end': {'line': end_line, 'character': end_char},
        },
        'newText': new_text,
    }


def _uri(workspace: Path, rel: str) -> str:
    return (workspace / rel).resolve().as_uri()


def _write_python_pair(env: Any) -> None:
    (env.workspace / 'pkg').mkdir(parents=True, exist_ok=True)
    (env.workspace / _A).write_text(_A_TEXT, encoding='utf-8')
    (env.workspace / _B).write_text(_B_TEXT, encoding='utf-8')


# --- symbol_column: 1-based UTF-16 column of the first whole-word match ---


def test_symbol_column_first_whole_word() -> None:
    assert symbol_column('let foo = foo_bar + foo;', 'foo') == 5


def test_symbol_column_after_identifier() -> None:
    assert symbol_column('foo_bar foo', 'foo') == 9


def test_symbol_column_substring_is_not_a_match() -> None:
    assert symbol_column('foobar', 'foo') is None


def test_symbol_column_dollar_is_a_word_char() -> None:
    assert symbol_column('$foo foo', 'foo') == 6


def test_symbol_column_counts_emoji_as_two_units() -> None:
    assert symbol_column('\U0001F600 x', 'x') == 4


def test_symbol_column_passes_over_a_quoted_match() -> None:
    assert symbol_column("config['timeout'] = timeout", 'timeout') == 21
    # Not the lifetime `'a`, the parameter `a`; a lifetime is still found by its own name.
    assert symbol_column("fn f<'a>(a: &'a u8)", 'a') == 10
    assert symbol_column("fn f<'a>(a: &'a u8)", "'a") == 6


def test_symbol_column_falls_back_to_a_quoted_match() -> None:
    assert symbol_column("x = 'timeout'", 'timeout') == 6


# --- apply_lsp_text_edits ---


def test_apply_edits_renames_every_occurrence() -> None:
    edits = [_edit(0, 3, 0, 6, 'bar'), _edit(1, 0, 1, 3, 'bar')]
    assert apply_lsp_text_edits('fn foo() {}\nfoo();\n', edits, 'foo') == 'fn bar() {}\nbar();\n'


def test_apply_edits_is_order_independent() -> None:
    edits = [_edit(0, 3, 0, 6, 'bar'), _edit(1, 0, 1, 3, 'bar')]
    assert apply_lsp_text_edits('fn foo() {}\nfoo();\n', list(reversed(edits)), 'foo') == 'fn bar() {}\nbar();\n'


def test_apply_edits_uses_utf16_characters() -> None:
    # The emoji on line 0 occupies two UTF-16 units, so `foo` starts at character 10, not 9.
    assert apply_lsp_text_edits('x = "\U0001F600"; foo\n', [_edit(0, 10, 0, 13, 'bar')], 'foo') == 'x = "\U0001F600"; bar\n'


def test_apply_edits_allows_an_empty_insert_range() -> None:
    assert apply_lsp_text_edits('S { x }\n', [_edit(0, 4, 0, 4, 'y: ')], 'x') == 'S { y: x }\n'


def test_apply_edits_normalizes_crlf_in_new_text() -> None:
    assert apply_lsp_text_edits('fn foo() {}\n', [_edit(0, 3, 0, 6, 'a\r\nb')], 'foo') == 'fn a\nb() {}\n'


def test_apply_edits_raises_when_the_span_lacks_the_old_name() -> None:
    with pytest.raises(StaleEditError):
        apply_lsp_text_edits('fn foo()\n', [_edit(0, 0, 0, 2, 'bar')], 'foo')


def test_apply_edits_accepts_a_span_without_the_names_sigil() -> None:
    # A server may replace only `count` of `#count` (or `a` of the lifetime `'a`).
    assert apply_lsp_text_edits('this.#count = 1;\n', [_edit(0, 6, 0, 11, 'total')], '#count') == 'this.#total = 1;\n'
    assert apply_lsp_text_edits("fn f<'a>() {}\n", [_edit(0, 6, 0, 7, 'b')], "'a") == "fn f<'b>() {}\n"


def test_apply_edits_raises_for_overlapping_edits() -> None:
    with pytest.raises(ValueError):
        apply_lsp_text_edits('fn foo() {}\n', [_edit(0, 3, 0, 6, 'bar'), _edit(0, 4, 0, 7, 'baz')], 'foo')


def test_apply_edits_raises_for_a_line_past_the_end() -> None:
    with pytest.raises(ValueError):
        apply_lsp_text_edits('a\nb\n', [_edit(5, 0, 5, 1, 'x')], 'a')


# --- the tool: end-to-end rename through the faked language server ---


def test_python_rename_writes_both_files_and_journals(env: Any) -> None:
    _write_python_pair(env)
    uri_a = _uri(env.workspace, _A)
    uri_b = _uri(env.workspace, _B)
    env.manager._rename_result = {
        'changes': {
            uri_a: [_edit(0, 4, 0, 7, 'bar')],
            uri_b: [_edit(0, 18, 0, 21, 'bar'), _edit(2, 0, 2, 3, 'bar')],
        }
    }

    out = lsp_rename_symbol.invoke({'relative_path': _B, 'line': 3, 'symbol': 'foo', 'new_name': 'bar'})

    assert env.manager.rename_calls == [(_B, 3, 1, 'bar')], env.manager.rename_calls
    assert env.servers and set(env.servers) == {'python'}, env.servers
    assert (env.workspace / _A).read_text(encoding='utf-8') == 'def bar():\n    return 1\n'
    assert (env.workspace / _B).read_text(encoding='utf-8') == 'from pkg.a import bar\n\nbar()\n'
    assert 'Renamed `foo` → `bar`' in out, out
    assert '3 edit(s) in 2 file(s)' in out, out
    assert '- `pkg/a.py` (1 edit(s))' in out, out
    assert '- `pkg/b.py` (2 edit(s))' in out, out
    assert 'No errors in the renamed files.' in out, out
    assert [c[0] for c in env.sync_calls] == [_A, _B], env.sync_calls
    assert [c[1].get('wait_for_diagnostics') for c in env.sync_calls] == [False, True], env.sync_calls
    assert env.journal_paths == [_A, _B], env.journal_paths


def test_rust_rename_applies_document_changes(env: Any) -> None:
    (env.workspace / 'src').mkdir(parents=True, exist_ok=True)
    (env.workspace / 'src' / 'lib.rs').write_text('pub fn foo() {}\n', encoding='utf-8')
    uri = _uri(env.workspace, 'src/lib.rs')
    env.manager._rename_result = {
        'documentChanges': [
            {'textDocument': {'uri': uri, 'version': 1}, 'edits': [_edit(0, 7, 0, 10, 'bar')]}
        ]
    }

    out = lsp_rename_symbol.invoke({'relative_path': 'src/lib.rs', 'line': 1, 'symbol': 'foo', 'new_name': 'bar'})

    assert env.servers and set(env.servers) == {'rust'}, env.servers
    assert (env.workspace / 'src' / 'lib.rs').read_text(encoding='utf-8') == 'pub fn bar() {}\n'
    assert 'Renamed `foo` → `bar`' in out, out


def test_stale_edit_leaves_every_file_unchanged(env: Any) -> None:
    _write_python_pair(env)
    uri_a = _uri(env.workspace, _A)
    uri_b = _uri(env.workspace, _B)
    # The b.py edit replaces 'from', which does not contain 'foo': a stale answer.
    env.manager._rename_result = {
        'changes': {
            uri_a: [_edit(0, 4, 0, 7, 'bar')],
            uri_b: [_edit(0, 0, 0, 4, 'bar')],
        }
    }

    out = lsp_rename_symbol.invoke({'relative_path': _B, 'line': 3, 'symbol': 'foo', 'new_name': 'bar'})

    assert out.startswith('Tool error:'), out
    assert 'does not match the file on disk' in out, out
    assert (env.workspace / _A).read_text(encoding='utf-8') == _A_TEXT
    assert (env.workspace / _B).read_text(encoding='utf-8') == _B_TEXT
    assert env.journal_paths == [], env.journal_paths
    assert env.sync_calls == [], env.sync_calls


def test_edit_outside_the_workspace_is_refused(env: Any, tmp_path: Path) -> None:
    _write_python_pair(env)
    outside = tmp_path / 'outside.py'
    outside.write_text('x = 1\n', encoding='utf-8')
    uri_b = _uri(env.workspace, _B)
    env.manager._rename_result = {
        'changes': {
            uri_b: [_edit(2, 0, 2, 3, 'bar')],
            outside.resolve().as_uri(): [_edit(0, 0, 0, 1, 'y')],
        }
    }

    out = lsp_rename_symbol.invoke({'relative_path': _B, 'line': 3, 'symbol': 'foo', 'new_name': 'bar'})

    assert out.startswith('Tool error:'), out
    assert 'outside the workspace' in out, out
    assert (env.workspace / _A).read_text(encoding='utf-8') == _A_TEXT
    assert (env.workspace / _B).read_text(encoding='utf-8') == _B_TEXT
    assert outside.read_text(encoding='utf-8') == 'x = 1\n'
    assert env.journal_paths == [], env.journal_paths


def test_symbol_not_a_whole_word_on_the_line(env: Any) -> None:
    _write_python_pair(env)

    out = lsp_rename_symbol.invoke({'relative_path': _B, 'line': 1, 'symbol': 'bar', 'new_name': 'baz'})

    assert out.startswith('Tool error:'), out
    assert 'is not a whole word on line 1' in out, out
    assert env.manager.rename_calls == [], env.manager.rename_calls
    assert (env.workspace / _B).read_text(encoding='utf-8') == _B_TEXT


def test_server_without_a_rename_provider(env: Any) -> None:
    _write_python_pair(env)
    env.manager._has_provider = False

    out = lsp_rename_symbol.invoke({'relative_path': _B, 'line': 3, 'symbol': 'foo', 'new_name': 'bar'})

    assert 'does not support rename' in out, out
    assert env.manager.rename_calls == [], env.manager.rename_calls
    assert (env.workspace / _B).read_text(encoding='utf-8') == _B_TEXT


def test_rename_returning_none_finds_nothing(env: Any) -> None:
    _write_python_pair(env)
    env.manager._rename_result = None

    out = lsp_rename_symbol.invoke({'relative_path': _B, 'line': 3, 'symbol': 'foo', 'new_name': 'bar'})

    assert 'found nothing to rename' in out, out
    assert (env.workspace / _B).read_text(encoding='utf-8') == _B_TEXT


def test_file_operations_in_the_answer_are_refused(env: Any) -> None:
    _write_python_pair(env)
    uri_a = _uri(env.workspace, _A)
    uri_a2 = _uri(env.workspace, 'pkg/a2.py')
    env.manager._rename_result = {
        'documentChanges': [
            {'kind': 'rename', 'oldUri': uri_a, 'newUri': uri_a2}
        ]
    }

    out = lsp_rename_symbol.invoke({'relative_path': _B, 'line': 3, 'symbol': 'foo', 'new_name': 'bar'})

    assert out.startswith('Tool error:'), out
    assert 'Nothing was written' in out, out
    assert (env.workspace / _A).read_text(encoding='utf-8') == _A_TEXT


def test_file_without_a_language_server_is_refused(env: Any) -> None:
    (env.workspace / 'notes.txt').write_text('foo\n', encoding='utf-8')

    out = lsp_rename_symbol.invoke({'relative_path': 'notes.txt', 'line': 1, 'symbol': 'foo', 'new_name': 'bar'})

    assert out.startswith('Tool error:'), out
    assert 'rename needs a file with a language server' in out, out
    assert env.servers == [], env.servers


def test_same_symbol_and_new_name_is_a_no_change(env: Any) -> None:
    _write_python_pair(env)

    out = lsp_rename_symbol.invoke({'relative_path': _B, 'line': 3, 'symbol': 'foo', 'new_name': 'foo'})

    assert out.startswith('No change:'), out
    assert env.servers == [], env.servers
    assert env.manager.rename_calls == [], env.manager.rename_calls


def test_diagnostics_are_reported_after_the_rename(env: Any) -> None:
    _write_python_pair(env)
    uri_a = _uri(env.workspace, _A)
    uri_b = _uri(env.workspace, _B)
    env.manager._rename_result = {
        'changes': {
            uri_a: [_edit(0, 4, 0, 7, 'bar')],
            uri_b: [_edit(0, 18, 0, 21, 'bar'), _edit(2, 0, 2, 3, 'bar')],
        }
    }
    env.manager._diagnostics = {
        _A: [
            {
                'relative_path': _A,
                'line': 1,
                'character': 5,
                'severity_value': 1,
                'message': 'boom',
            }
        ]
    }

    out = lsp_rename_symbol.invoke({'relative_path': _B, 'line': 3, 'symbol': 'foo', 'new_name': 'bar'})

    assert 'Errors in the renamed files (1):' in out, out
    assert '- `pkg/a.py` 1:5 boom' in out, out


@pytest.mark.parametrize('settled', [True, False])
def test_a_server_without_readiness_reports_is_waited_for(env: Any, settled: bool) -> None:
    _write_python_pair(env)
    waits: list[float] = []

    def _wait_for_workspace_analysis(*, timeout_s: float) -> bool:
        waits.append(timeout_s)
        return settled

    env.manager.reports_readiness = False
    env.manager.wait_for_workspace_analysis = _wait_for_workspace_analysis
    env.manager._rename_result = {'changes': {_uri(env.workspace, _A): [_edit(0, 4, 0, 7, 'bar')]}}

    out = lsp_rename_symbol.invoke({'relative_path': _A, 'line': 1, 'symbol': 'foo', 'new_name': 'bar'})

    assert waits == [60.0], waits
    assert (env.workspace / _A).read_text(encoding='utf-8') == 'def bar():\n    return 1\n'
    assert ('was still analyzing the workspace' in out) is not settled, out


def test_crlf_line_endings_are_preserved(env: Any) -> None:
    (env.workspace / 'pkg').mkdir(parents=True, exist_ok=True)
    (env.workspace / _A).write_bytes(b'def foo():\r\n    pass\r\n')
    uri_a = _uri(env.workspace, _A)
    env.manager._rename_result = {'changes': {uri_a: [_edit(0, 4, 0, 7, 'bar')]}}

    out = lsp_rename_symbol.invoke({'relative_path': _A, 'line': 1, 'symbol': 'foo', 'new_name': 'bar'})

    assert 'Renamed `foo` → `bar`' in out, out
    assert (env.workspace / _A).read_bytes() == b'def bar():\r\n    pass\r\n'


@pytest.mark.parametrize(
    ('symbol', 'new_name'),
    [('self.foo', 'bar'), ('Type::foo', 'bar'), ('foo', 'a.bar'), ('foo', 'two words')],
)
def test_a_name_that_is_not_one_identifier_is_refused(env: Any, symbol: str, new_name: str) -> None:
    # `self.foo` would put the column on `self` and rename that.
    _write_python_pair(env)

    out = lsp_rename_symbol.invoke({'relative_path': _B, 'line': 3, 'symbol': symbol, 'new_name': new_name})

    assert out.startswith('Tool error:'), out
    assert 'must be one identifier' in out, out
    assert env.servers == [], env.servers


def test_a_failed_write_puts_back_the_files_already_renamed(env: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    _write_python_pair(env)
    original_a = b'def foo():\r\n    return 1\r\n'
    (env.workspace / _A).write_bytes(original_a)
    env.manager._rename_result = {
        'changes': {
            _uri(env.workspace, _A): [_edit(0, 4, 0, 7, 'bar')],
            _uri(env.workspace, _B): [_edit(0, 18, 0, 21, 'bar'), _edit(2, 0, 2, 3, 'bar')],
        }
    }
    real_commit = rename_module.commit_edit

    def _commit(t: Any, text: str, mode: str) -> str | None:
        if t.rel == _B:
            return f'Tool error: could not write `{_B}` (denied).'
        return real_commit(t, text, mode)

    monkeypatch.setattr(rename_module, 'commit_edit', _commit)

    out = lsp_rename_symbol.invoke({'relative_path': _B, 'line': 3, 'symbol': 'foo', 'new_name': 'bar'})

    assert out.startswith(f'Tool error: could not write `{_B}`'), out
    assert 'Nothing was written' in out, out
    assert (env.workspace / _A).read_bytes() == original_a, 'a.py was renamed first and is put back byte for byte'
    assert (env.workspace / _B).read_text(encoding='utf-8') == _B_TEXT
    assert env.sync_calls == [], env.sync_calls


def test_a_file_another_call_of_the_response_wrote_is_refused(env: Any) -> None:
    from clara_coder_backend.session.state import current_tool_batch_id

    _write_python_pair(env)
    uri_b = _uri(env.workspace, _B)
    env.manager._rename_result = {
        'changes': {
            _uri(env.workspace, _A): [_edit(0, 4, 0, 7, 'bar')],
            uri_b: [_edit(0, 18, 0, 21, 'bar'), _edit(2, 0, 2, 3, 'bar')],
        }
    }
    token = current_tool_batch_id.set('batch-renames')
    try:
        first = lsp_rename_symbol.invoke({'relative_path': _B, 'line': 3, 'symbol': 'foo', 'new_name': 'bar'})
        # A second rename in the same response: its server answer may predate the first one's writes.
        env.manager._rename_result = {'changes': {uri_b: [_edit(0, 5, 0, 8, 'lib')]}}
        second = lsp_rename_symbol.invoke({'relative_path': _B, 'line': 1, 'symbol': 'pkg', 'new_name': 'lib'})
    finally:
        current_tool_batch_id.reset(token)

    assert first.startswith('Renamed'), first
    assert second.startswith('Tool error:'), second
    assert f'same response already changed `{_B}`' in second, second
    assert (env.workspace / _B).read_text(encoding='utf-8') == 'from pkg.a import bar\n\nbar()\n'


def test_a_file_that_changed_while_the_server_renamed_is_refused(env: Any) -> None:
    _write_python_pair(env)
    shifted = '# added\n' + _B_TEXT

    def _rename(rel: str, line: int, character: int, new_name: str) -> Any:
        # Something writes b.py while the server works: its answer is for the old lines.
        (env.workspace / _B).write_text(shifted, encoding='utf-8')
        return {'changes': {_uri(env.workspace, _B): [_edit(2, 0, 2, 3, 'bar')]}}

    env.manager.rename = _rename

    out = lsp_rename_symbol.invoke({'relative_path': _B, 'line': 3, 'symbol': 'foo', 'new_name': 'bar'})

    assert out.startswith('Tool error:'), out
    assert 'changed while' in out, out
    assert (env.workspace / _B).read_text(encoding='utf-8') == shifted


def test_a_file_that_is_not_valid_in_its_encoding_is_refused(env: Any) -> None:
    # Read with replacement characters, a latin-1 `é` would be written back as U+FFFD.
    _write_python_pair(env)
    latin1 = b'def foo():  # caf\xe9\n    return 1\n'
    (env.workspace / _A).write_bytes(latin1)
    env.manager._rename_result = {
        'changes': {
            _uri(env.workspace, _A): [_edit(0, 4, 0, 7, 'bar')],
            _uri(env.workspace, _B): [_edit(0, 18, 0, 21, 'bar'), _edit(2, 0, 2, 3, 'bar')],
        }
    }

    out = lsp_rename_symbol.invoke({'relative_path': _B, 'line': 3, 'symbol': 'foo', 'new_name': 'bar'})

    assert out.startswith(f'Tool error: `{_A}` is not valid'), out
    assert (env.workspace / _A).read_bytes() == latin1
    assert (env.workspace / _B).read_text(encoding='utf-8') == _B_TEXT


def test_lsp_rename_symbol_is_registered_as_an_edit_tool() -> None:
    on_tools, on_map = worker_tools_and_map(True)
    off_tools, off_map = worker_tools_and_map(False)
    assert 'lsp_rename_symbol' in on_map
    assert any(t.name == 'lsp_rename_symbol' for t in on_tools)
    assert 'lsp_rename_symbol' not in off_map
    assert not any(t.name == 'lsp_rename_symbol' for t in off_tools)
    assert subagent_tool_group('lsp_rename_symbol') == 'edit'
