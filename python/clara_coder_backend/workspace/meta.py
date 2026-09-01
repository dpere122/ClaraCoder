"""Workspace-local Clara metadata directory (``.clara``)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

WORKSPACE_META_DIR = '.clara'
LEGACY_WORKSPACE_META_DIR = '.nemo'
SYSTEM_PROMPT_FILENAME = 'system-prompt.md'
BUILD_PLANS_DIR_NAME = 'build-plans'
BUILD_PLANS_REL_DIR = f'{WORKSPACE_META_DIR}/{BUILD_PLANS_DIR_NAME}'
LEGACY_BUILD_PLANS_REL_DIR = f'{LEGACY_WORKSPACE_META_DIR}/{BUILD_PLANS_DIR_NAME}'
SYSTEM_PROMPT_RELATIVE_PATH = f'{WORKSPACE_META_DIR}/{SYSTEM_PROMPT_FILENAME}'
INDEX_FILENAME = 'index.json'

_LEGACY_BUILD_PLANS_PREFIX = f'{LEGACY_BUILD_PLANS_REL_DIR}/'
_BUILD_PLANS_PREFIX = f'{BUILD_PLANS_REL_DIR}/'


def rewrite_legacy_build_plan_relative_path(relative_path: str) -> str:
    """Map ``.nemo/build-plans/...`` to ``.clara/build-plans/...``."""
    n = (relative_path or '').replace('\\', '/')
    if n.startswith(_LEGACY_BUILD_PLANS_PREFIX):
        return _BUILD_PLANS_PREFIX + n[len(_LEGACY_BUILD_PLANS_PREFIX) :]
    if n == LEGACY_BUILD_PLANS_REL_DIR:
        return BUILD_PLANS_REL_DIR
    return n


def _rewrite_build_plan_index_file(index_path: Path) -> None:
    if not index_path.is_file():
        return
    try:
        data = json.loads(index_path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return
    if not isinstance(data, list):
        return
    changed = False
    rewritten: list[Any] = []
    for entry in data:
        if not isinstance(entry, dict):
            rewritten.append(entry)
            continue
        rel = str(entry.get('relativePath') or '')
        next_rel = rewrite_legacy_build_plan_relative_path(rel)
        if next_rel != rel:
            entry = {**entry, 'relativePath': next_rel}
            changed = True
        rewritten.append(entry)
    if changed:
        index_path.write_text(json.dumps(rewritten, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')


def migrate_legacy_workspace_meta_dir(workspace_root: str | Path) -> None:
    """Rename ``{root}/.nemo`` to ``{root}/.clara`` when the target does not exist.

    After a successful rename, rewrite ``build-plans/index.json`` relativePath values.
    If both folders exist, leave ``.nemo`` in place (no merge).
    """
    root = Path(workspace_root).resolve()
    legacy = root / LEGACY_WORKSPACE_META_DIR
    current = root / WORKSPACE_META_DIR
    if legacy.is_dir() and not current.exists():
        try:
            legacy.rename(current)
        except OSError:
            return
    index_path = current / BUILD_PLANS_DIR_NAME / INDEX_FILENAME
    _rewrite_build_plan_index_file(index_path)
