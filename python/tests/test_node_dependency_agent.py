"""Node/npm dependency agent helpers."""

from __future__ import annotations

from pathlib import Path

import pytest

from nemo_backend.node_dependency_agent import (
    _package_json_script_gate,
    detect_package_manager,
    _resolve_project_dir,
)


def test_detect_package_manager_prefers_pnpm_lock(tmp_path: Path) -> None:
    (tmp_path / 'package.json').write_text('{}', encoding='utf-8')
    (tmp_path / 'pnpm-lock.yaml').write_text('lockfile: {}\n', encoding='utf-8')
    assert detect_package_manager(tmp_path) == 'pnpm'


def test_detect_package_manager_prefers_yarn_lock(tmp_path: Path) -> None:
    (tmp_path / 'package.json').write_text('{}', encoding='utf-8')
    (tmp_path / 'yarn.lock').write_text('# yarn lockfile\n', encoding='utf-8')
    assert detect_package_manager(tmp_path) == 'yarn'


def test_detect_package_manager_defaults_npm(tmp_path: Path) -> None:
    (tmp_path / 'package.json').write_text('{}', encoding='utf-8')
    assert detect_package_manager(tmp_path) == 'npm'


def test_resolve_project_dir_rejects_escape(tmp_path: Path) -> None:
    root = tmp_path.resolve()
    _, err, _ = _resolve_project_dir(root, '..')
    assert err is not None
    assert 'inside the workspace' in err


def test_package_json_script_gate_allows_listed_script(tmp_path: Path) -> None:
    (tmp_path / 'package.json').write_text(
        '{"scripts": {"test": "jest", "build": "tsc"}}',
        encoding='utf-8',
    )
    assert _package_json_script_gate(tmp_path, 'test') is None


def test_package_json_script_gate_rejects_unknown_script(tmp_path: Path) -> None:
    (tmp_path / 'package.json').write_text(
        '{"scripts": {"test": "jest"}}',
        encoding='utf-8',
    )
    err = _package_json_script_gate(tmp_path, 'lint')
    assert err is not None
    assert 'not listed' in err
    assert '`test`' in err


def test_package_json_script_gate_skips_when_no_scripts_object(tmp_path: Path) -> None:
    (tmp_path / 'package.json').write_text('{}', encoding='utf-8')
    assert _package_json_script_gate(tmp_path, 'anything') is None


def test_package_json_script_gate_skips_on_invalid_json(tmp_path: Path) -> None:
    (tmp_path / 'package.json').write_text('{not json', encoding='utf-8')
    assert _package_json_script_gate(tmp_path, 'test') is None
