"""Tests for workspace Python interpreter discovery / defaults."""

from __future__ import annotations

import sys
from pathlib import Path

from clara_coder_backend.runtime.python_interpreter_select import (
    APP_BACKEND_INTERPRETER_ID,
    RUNTIME_VENV_INTERPRETER_ID,
    discover_workspace_python_interpreters,
    resolve_default_interpreter_entry,
)


def test_discover_includes_runtime_venv_first(tmp_path: Path, monkeypatch) -> None:
    workspace = tmp_path / 'ws'
    workspace.mkdir()
    runtime = tmp_path / 'runtime-venv'
    py = runtime / ('Scripts' if sys.platform.startswith('win') else 'bin') / (
        'python.exe' if sys.platform.startswith('win') else 'python'
    )
    py.parent.mkdir(parents=True)
    py.write_text('', encoding='utf-8')

    monkeypatch.setenv('CLARA_RUNTIME_PYTHON_DIR', str(runtime))

    rows = discover_workspace_python_interpreters(workspace)
    assert rows[0]['id'] == RUNTIME_VENV_INTERPRETER_ID
    assert Path(rows[0]['pythonExecutable']) == py.resolve()
    default = resolve_default_interpreter_entry(workspace)
    assert default is not None
    assert default['id'] == RUNTIME_VENV_INTERPRETER_ID


def test_default_falls_back_to_app_backend_without_runtime(tmp_path: Path, monkeypatch) -> None:
    workspace = tmp_path / 'ws'
    workspace.mkdir()
    monkeypatch.delenv('CLARA_RUNTIME_PYTHON_DIR', raising=False)
    monkeypatch.setenv('CLARA_RUNTIME_DIR', str(tmp_path / 'missing-runtime'))

    rows = discover_workspace_python_interpreters(workspace)
    ids = [r['id'] for r in rows]
    assert RUNTIME_VENV_INTERPRETER_ID not in ids
    assert APP_BACKEND_INTERPRETER_ID in ids
    default = resolve_default_interpreter_entry(workspace)
    assert default is not None
    assert default['id'] == APP_BACKEND_INTERPRETER_ID
