"""Root .gitignore + built-in ignore behavior for workspace tools."""

from __future__ import annotations

import tempfile
import uuid
from pathlib import Path

import pytest

from nemo_backend.search_backend import SearchLineMatch
from nemo_backend.state import current_session_id, get_session
from nemo_backend.workspace_ignore import (
    get_workspace_ignore_rules_cached,
    iter_workspace_search_files,
    matches_ignore_rule,
    should_ignore_workspace_entry,
)
from nemo_backend.workspace_tools import list_workspace_directory, search_workspace


# --- TestMatchesIgnoreRule ---

def test_trailing_slash_directory() -> None:
    assert matches_ignore_rule('secret', 'secret', 'secret/')
    assert matches_ignore_rule('secret/x', 'x', 'secret/')
    assert not matches_ignore_rule('sec', 'sec', 'secret/')


def test_glob_ext() -> None:
    assert matches_ignore_rule('a/b/foo.log', 'foo.log', '*.log')
    assert not matches_ignore_rule('a/b/foo.txt', 'foo.txt', '*.log')


def test_unanchored_segment() -> None:
    assert matches_ignore_rule('x/vendor/y', 'y', 'vendor')
    assert matches_ignore_rule('vendor', 'vendor', 'vendor')


def test_anchored_path() -> None:
    assert matches_ignore_rule('src/only', 'only', '/src/only')
    assert not matches_ignore_rule('other/src/only', 'only', '/src/only')


# --- TestShouldIgnoreBuiltins ---

def test_node_modules_by_name() -> None:
    assert should_ignore_workspace_entry('node_modules', 'node_modules', [])


def test_venv_dirs_by_name() -> None:
    assert should_ignore_workspace_entry('.venv', '.venv', [])
    assert should_ignore_workspace_entry('venv', 'venv', [])


def test_log_suffix() -> None:
    assert should_ignore_workspace_entry('x.log', 'x.log', [])


# --- TestToolsWithGitignore (uses fixture) ---

@pytest.fixture()
def workspace_session():
    td = tempfile.TemporaryDirectory()
    root = Path(td.name)
    session_id = f'ws-ignore-{uuid.uuid4().hex}'
    session = get_session(session_id)
    session.workspace_path = str(root)
    token = current_session_id.set(session_id)
    yield root
    current_session_id.reset(token)
    td.cleanup()


def test_list_hides_gitignored_entries(workspace_session: Path) -> None:
    root = workspace_session
    (root / '.gitignore').write_text('secret/\n*.tmp\n', encoding='utf-8')
    (root / 'visible.txt').write_text('ok', encoding='utf-8')
    (root / 'secret').mkdir()
    (root / 'secret' / 'nope.txt').write_text('x', encoding='utf-8')
    (root / 'a.tmp').write_text('t', encoding='utf-8')

    out = list_workspace_directory.invoke({'relative_path': '.'})
    assert 'visible.txt' in out
    assert 'secret/' not in out
    assert 'a.tmp' not in out


def test_search_skips_gitignored_files(workspace_session: Path) -> None:
    root = workspace_session
    (root / '.gitignore').write_text('ignored_dir/\n', encoding='utf-8')
    (root / 'keep.py').write_text('needle here\n', encoding='utf-8')
    ign = root / 'ignored_dir'
    ign.mkdir()
    (ign / 'x.py').write_text('needle hidden\n', encoding='utf-8')

    out = search_workspace.invoke({'query': 'needle', 'max_matches': 20})
    assert 'keep.py' in out
    assert 'ignored_dir' not in out


def test_search_workspace_uses_grep_when_available(workspace_session: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = workspace_session
    (root / 'keep.py').write_text('needle here\n', encoding='utf-8')
    seen: list[tuple[str, ...]] = []

    def _fake_run_grep_line_search(query: str, candidates, **kwargs):
        del kwargs
        seen.append(tuple(candidate.display_path for candidate in candidates))
        assert query == 'needle'
        return [SearchLineMatch(display_path='keep.py', line_number=1)]

    monkeypatch.setattr('nemo_backend.workspace_tools.run_grep_line_search', _fake_run_grep_line_search)

    out = search_workspace.invoke({'query': 'needle', 'max_matches': 20})

    assert seen == [('keep.py',)]
    assert '[keep.py line 1] │ needle here' in out


def test_get_workspace_ignore_rules_cached_stable(workspace_session: Path) -> None:
    root = workspace_session
    (root / '.gitignore').write_text('foo\n', encoding='utf-8')
    a = get_workspace_ignore_rules_cached(root)
    b = get_workspace_ignore_rules_cached(root)
    assert a == b
    assert a == ['foo']


def test_iter_workspace_search_files_prunes(workspace_session: Path) -> None:
    root = workspace_session
    (root / '.gitignore').write_text('big/\n', encoding='utf-8')
    big = root / 'big'
    big.mkdir()
    (big / 'inner.txt').write_text('x', encoding='utf-8')
    (root / 'top.txt').write_text('y', encoding='utf-8')
    rules = get_workspace_ignore_rules_cached(root)
    paths = list(iter_workspace_search_files(root, rules))
    rels = {p.relative_to(root.resolve()).as_posix() for p in paths}
    assert 'top.txt' in rels
    assert all(not r.startswith('big/') for r in rels)


def test_gitignore_cache_evicts_oldest_when_over_max(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import nemo_backend.workspace_ignore as wi

    monkeypatch.setattr(wi, '_MAX_GITIGNORE_CACHE_ENTRIES', 2)
    wi._gitignore_cache.clear()
    r1 = tmp_path / 'g1'
    r1.mkdir()
    r2 = tmp_path / 'g2'
    r2.mkdir()
    r3 = tmp_path / 'g3'
    r3.mkdir()
    (r1 / '.gitignore').write_text('a\n', encoding='utf-8')
    (r2 / '.gitignore').write_text('b\n', encoding='utf-8')
    (r3 / '.gitignore').write_text('c\n', encoding='utf-8')
    get_workspace_ignore_rules_cached(r1)
    get_workspace_ignore_rules_cached(r2)
    assert len(wi._gitignore_cache) == 2
    get_workspace_ignore_rules_cached(r3)
    assert len(wi._gitignore_cache) == 2
    assert str(r1.resolve()) not in wi._gitignore_cache
    assert get_workspace_ignore_rules_cached(r3) == ['c']


def test_search_workspace_falls_back_when_grep_returns_none(workspace_session: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = workspace_session
    (root / 'keep.py').write_text('needle here\n', encoding='utf-8')

    monkeypatch.setattr('nemo_backend.workspace_tools.run_grep_line_search', lambda *a, **k: None)

    out = search_workspace.invoke({'query': 'needle', 'max_matches': 20})
    assert 'keep.py' in out
