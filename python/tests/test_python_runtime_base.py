"""Tests for durable base-Python selection when reinstalling the runtime venv."""

from __future__ import annotations

from pathlib import Path

import pytest

from clara_coder_backend.runtime.deps.providers import python_runtime as pr


def test_base_python_skips_interpreter_inside_target_venv(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    target = tmp_path / 'python-venv'
    inside = target / 'bin' / 'python'
    inside.parent.mkdir(parents=True)
    inside.write_text('#!/bin/sh\n', encoding='utf-8')
    inside.chmod(0o755)

    durable = tmp_path / 'portable' / 'python'
    durable.parent.mkdir(parents=True)
    durable.write_text('#!/bin/sh\n', encoding='utf-8')
    durable.chmod(0o755)

    monkeypatch.setattr(pr.sys, 'executable', str(inside))
    monkeypatch.setattr(pr.sys, '_base_executable', str(durable), raising=False)
    monkeypatch.setattr(pr.shutil, 'which', lambda _name: None)
    monkeypatch.setenv('CLARA_PYTHON', '')
    monkeypatch.setenv('PYTHON', '')

    assert Path(pr._base_python(target)).resolve() == durable.resolve()


def test_base_python_prefers_clara_python_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    target = tmp_path / 'python-venv'
    override = tmp_path / 'override-python'
    override.write_text('#!/bin/sh\n', encoding='utf-8')
    override.chmod(0o755)

    monkeypatch.setenv('CLARA_PYTHON', str(override))
    monkeypatch.setattr(pr.sys, 'executable', str(tmp_path / 'missing'))
    monkeypatch.setattr(pr.sys, '_base_executable', '', raising=False)
    monkeypatch.setattr(pr.shutil, 'which', lambda _name: None)

    assert Path(pr._base_python(target)).resolve() == override.resolve()


def test_base_python_reads_bare_python_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    target = tmp_path / 'python-venv'
    override = tmp_path / 'python-from-env'
    override.write_text('#!/bin/sh\n', encoding='utf-8')
    override.chmod(0o755)

    monkeypatch.delenv('CLARA_PYTHON', raising=False)
    monkeypatch.delenv('NEMO_PYTHON', raising=False)
    monkeypatch.setenv('PYTHON', str(override))
    monkeypatch.setattr(pr.sys, 'executable', str(tmp_path / 'missing'))
    monkeypatch.setattr(pr.sys, '_base_executable', '', raising=False)
    monkeypatch.setattr(pr.shutil, 'which', lambda _name: None)

    assert Path(pr._base_python(target)).resolve() == override.resolve()


def test_base_python_errors_when_only_target_venv_exists(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    target = tmp_path / 'python-venv'
    inside = target / 'bin' / 'python'
    inside.parent.mkdir(parents=True)
    inside.write_text('#!/bin/sh\n', encoding='utf-8')
    inside.chmod(0o755)

    monkeypatch.delenv('CLARA_PYTHON', raising=False)
    monkeypatch.delenv('PYTHON', raising=False)
    monkeypatch.setattr(pr.sys, 'executable', str(inside))
    monkeypatch.setattr(pr.sys, '_base_executable', str(inside), raising=False)
    monkeypatch.setattr(pr.shutil, 'which', lambda _name: None)

    with pytest.raises(RuntimeError, match='durable Python'):
        pr._base_python(target)
