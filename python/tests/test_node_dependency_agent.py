"""Node/npm dependency agent helpers."""

from __future__ import annotations

from pathlib import Path

from clara_coder_backend.workspace.npm_projects import detect_package_manager


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
