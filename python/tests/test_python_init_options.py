"""Tests for basedpyright LSP initialization options (pythonPath + venv metadata)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from clara_coder_backend.domain import SessionState
from clara_coder_backend.lsp.python_init_options import (
    build_python_initialization_options,
    deduce_venv_root_from_interpreter,
    python_environment_path_for_workspace,
    python_interpreter_path_for_workspace,
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


def test_python_environment_path_from_session_venv(tmp_path: Path) -> None:
    session = SessionState()
    vdir = tmp_path / '.venv'
    vdir.mkdir()
    session.python_workspace_venv_path = str(vdir)
    assert python_environment_path_for_workspace(session, tmp_path) == str(vdir.resolve())


def test_python_interpreter_path_from_session_executable(tmp_path: Path) -> None:
    session = SessionState()
    exe = tmp_path / 'python.exe' if sys.platform.startswith('win') else tmp_path / 'python'
    exe.write_text('', encoding='utf-8')
    session.python_workspace_python_executable = str(exe)
    assert python_interpreter_path_for_workspace(session, tmp_path) == str(exe.resolve())


def test_build_python_initialization_options_includes_analysis_defaults(tmp_path: Path) -> None:
    session = SessionState()
    opts = build_python_initialization_options(session, tmp_path)
    analysis = opts['basedpyright']['analysis']
    assert analysis['diagnosticMode'] == 'openFilesOnly'
    assert analysis['typeCheckingMode'] == 'standard'
    assert analysis['autoSearchPaths'] is True
    assert analysis['useLibraryCodeForTypes'] is True
    assert 'python' not in opts


def test_build_python_initialization_options_python_path_when_interpreter_set(tmp_path: Path) -> None:
    session = SessionState()
    exe = tmp_path / ('python.exe' if sys.platform.startswith('win') else 'python')
    exe.write_text('', encoding='utf-8')
    session.python_workspace_python_executable = str(exe)
    opts = build_python_initialization_options(session, tmp_path)
    assert opts.get('python') == {'pythonPath': str(exe.resolve())}
