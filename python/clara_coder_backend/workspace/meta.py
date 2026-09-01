"""Workspace-local Clara metadata directory (``.clara``)."""

from __future__ import annotations

import json
import logging
import shutil
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

logger = logging.getLogger('clara.workspace.meta')


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


def _read_index_entries(index_path: Path) -> list[dict[str, Any]]:
    if not index_path.is_file():
        return []
    try:
        data = json.loads(index_path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(data, list):
        return []
    return [entry for entry in data if isinstance(entry, dict)]


def _with_rewritten_relative_path(entry: dict[str, Any]) -> dict[str, Any]:
    rel = str(entry.get('relativePath') or '')
    next_rel = rewrite_legacy_build_plan_relative_path(rel)
    if next_rel == rel:
        return entry
    return {**entry, 'relativePath': next_rel}


def _merge_build_plan_index_entries(
    clara_entries: list[dict[str, Any]],
    nemo_entries: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Union by ``id``, preferring ``.clara`` entries when ids collide."""
    seen_ids: set[str] = set()
    merged: list[dict[str, Any]] = []
    for entry in clara_entries:
        rewritten = _with_rewritten_relative_path(entry)
        eid = str(rewritten.get('id') or '')
        if eid:
            seen_ids.add(eid)
        merged.append(rewritten)
    for entry in nemo_entries:
        rewritten = _with_rewritten_relative_path(entry)
        eid = str(rewritten.get('id') or '')
        if eid and eid in seen_ids:
            continue
        if eid:
            seen_ids.add(eid)
        merged.append(rewritten)
    return merged


def _copy_missing_files(src_root: Path, dest_root: Path) -> None:
    """Recursively copy files from ``src_root`` that are absent under ``dest_root``."""
    try:
        for src in src_root.rglob('*'):
            try:
                if not src.is_file():
                    continue
                dest = dest_root / src.relative_to(src_root)
                if dest.exists():
                    continue
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dest)
            except OSError as exc:
                logger.warning('[workspace-meta] Failed to copy legacy metadata file: %s', exc)
    except OSError as exc:
        logger.warning('[workspace-meta] Failed to copy legacy metadata dir: %s', exc)


def _write_merged_index(index_path: Path, entries: list[dict[str, Any]]) -> None:
    try:
        index_path.parent.mkdir(parents=True, exist_ok=True)
        index_path.write_text(
            json.dumps(entries, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )
    except OSError as exc:
        logger.warning('[workspace-meta] Failed to write merged build-plan index: %s', exc)


def migrate_legacy_workspace_meta_dir(workspace_root: str | Path) -> None:
    """Rename ``{root}/.nemo`` to ``{root}/.clara`` when the target does not exist.

    After a successful rename, rewrite ``build-plans/index.json`` relativePath values.
    If both folders exist, copy missing files from ``.nemo`` into ``.clara`` and merge
    ``build-plans/index.json`` (preferring ``.clara`` entries on id collision).
    ``.nemo`` is left in place when a merge is required.
    """
    if not (str(workspace_root) or '').strip():
        return
    root = Path(workspace_root).resolve()
    legacy = root / LEGACY_WORKSPACE_META_DIR
    current = root / WORKSPACE_META_DIR
    try:
        if legacy.is_dir() and not current.exists():
            legacy.rename(current)
        elif legacy.is_dir() and current.exists():
            _copy_missing_files(legacy, current)
            merged = _merge_build_plan_index_entries(
                _read_index_entries(current / BUILD_PLANS_DIR_NAME / INDEX_FILENAME),
                _read_index_entries(legacy / BUILD_PLANS_DIR_NAME / INDEX_FILENAME),
            )
            _write_merged_index(current / BUILD_PLANS_DIR_NAME / INDEX_FILENAME, merged)
    except OSError as exc:
        logger.warning('[workspace-meta] Failed to migrate legacy metadata dir: %s', exc)
    index_path = current / BUILD_PLANS_DIR_NAME / INDEX_FILENAME
    try:
        _rewrite_build_plan_index_file(index_path)
    except OSError as exc:
        logger.warning('[workspace-meta] Failed to rewrite build-plan index paths: %s', exc)
