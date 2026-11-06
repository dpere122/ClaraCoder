"""Tests for basedpyright LSP initialization options (pythonPath + venv metadata)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from clara_coder_backend.domain import RuntimePythonLspConfig, SessionState
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


def test_build_python_initialization_options_defaults_match_basedpyright_inlay_defaults(tmp_path: Path) -> None:
    analysis = build_python_initialization_options(SessionState(), tmp_path, RuntimePythonLspConfig())['basedpyright'][
        'analysis'
    ]
    assert analysis['autoImportCompletions'] is True
    assert analysis['inlayHints'] == {
        'variableTypes': True,
        'callArgumentNames': True,
        'functionReturnTypes': True,
        'genericTypes': False,
    }
    assert 'extraPaths' not in analysis, 'no extraPaths key, so a project config can still set them'


def test_build_python_initialization_options_applies_settings(tmp_path: Path) -> None:
    settings = RuntimePythonLspConfig(
        type_checking_mode='strict',
        diagnostic_mode='workspace',
        inlay_variable_types=False,
        inlay_call_argument_names=False,
        inlay_function_return_types=False,
        inlay_generic_types=True,
        auto_import_completions=False,
        extra_paths=['src', 'libs/vendored'],
    )
    analysis = build_python_initialization_options(SessionState(), tmp_path, settings)['basedpyright']['analysis']
    assert analysis['typeCheckingMode'] == 'strict'
    assert analysis['diagnosticMode'] == 'workspace'
    assert analysis['autoImportCompletions'] is False
    assert analysis['inlayHints'] == {
        'variableTypes': False,
        'callArgumentNames': False,
        'functionReturnTypes': False,
        'genericTypes': True,
    }
    assert analysis['extraPaths'] == ['src', 'libs/vendored']
    assert analysis['extraPaths'] is not settings.extra_paths


def test_build_python_initialization_options_reads_runtime_settings(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from clara_coder_backend.session.state import runtime_config

    monkeypatch.setattr(runtime_config.lsp, 'python', RuntimePythonLspConfig(type_checking_mode='all'))
    analysis = build_python_initialization_options(SessionState(), tmp_path)['basedpyright']['analysis']
    assert analysis['typeCheckingMode'] == 'all'
