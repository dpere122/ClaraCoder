"""Tests for Jedi LSP initialization options (venv path for library hover)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from nemo_backend.domain import SessionState
from nemo_backend.lsp.jedi_init_options import (
    build_jedi_initialization_options,
    deduce_venv_root_from_interpreter,
    jedi_environment_path_for_workspace,
)


def test_deduce_venv_root_posix(tmp_path: Path) -> None:
    if sys.platform.startswith('win'):
        pytest.skip('POSIX layout')
    root = tmp_path / '.venv'
    bindir = root / 'bin'
    bindir.mkdir(parents=True)
    exe = bindir / 'python3'
    exe.write_text('', encoding='utf-8')
    assert deduce_venv_root_from_interpreter(exe) == root.resolve()


def test_deduce_venv_root_windows(tmp_path: Path) -> None:
    if not sys.platform.startswith('win'):
        pytest.skip('Windows layout')
    root = tmp_path / '.venv'
    scripts = root / 'Scripts'
    scripts.mkdir(parents=True)
    exe = scripts / 'python.exe'
    exe.write_text('', encoding='utf-8')
    assert deduce_venv_root_from_interpreter(exe) == root.resolve()


def test_deduce_non_venv_returns_none(tmp_path: Path) -> None:
    exe = tmp_path / 'python'
    exe.write_text('', encoding='utf-8')
    assert deduce_venv_root_from_interpreter(exe) is None


def test_jedi_environment_path_from_session_venv(tmp_path: Path) -> None:
    session = SessionState()
    vdir = tmp_path / '.venv'
    vdir.mkdir()
    session.python_workspace_venv_path = str(vdir)
    assert jedi_environment_path_for_workspace(session, tmp_path) == str(vdir.resolve())


def test_build_jedi_initialization_options_includes_semantic_tokens(tmp_path: Path) -> None:
    session = SessionState()
    opts = build_jedi_initialization_options(session, tmp_path)
    assert opts['semanticTokens'] == {'enable': True}
    assert opts.get('completion') == {'resolveEagerly': True}


def test_build_jedi_initialization_options_workspace_when_venv_set(tmp_path: Path) -> None:
    session = SessionState()
    vdir = tmp_path / '.venv'
    vdir.mkdir()
    session.python_workspace_venv_path = str(vdir)
    opts = build_jedi_initialization_options(session, tmp_path)
    assert opts.get('workspace') == {'environmentPath': str(vdir.resolve())}
