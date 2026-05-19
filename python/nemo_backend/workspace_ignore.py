"""Root `.gitignore` + built-in ignore lists for workspace tools (aligned with Electron context tree)."""

from __future__ import annotations

import os
from collections import OrderedDict
from collections.abc import Iterator
from pathlib import Path

from nemo_backend.state import runtime_config

# Keep aligned with src/main/constants.ts WORKSPACE_CONTEXT_IGNORED_NAMES
WORKSPACE_CONTEXT_IGNORED_NAMES: frozenset[str] = frozenset(
    {
        '.git',
        '.angular',
        '.cache',
        '.cursor',
        '.idea',
        '.next',
        '.nemo',
        '.nuxt',
        '.svn',
        '.venv',
        '.vscode',
        '__pycache__',
        'bin',
        'build',
        'coverage',
        'dist',
        'node_modules',
        'obj',
        'out',
        'target',
        'tmp',
        'vendor',
        'venv',
    }
)

# Keep aligned with src/main/constants.ts WORKSPACE_CONTEXT_IGNORED_SUFFIXES
WORKSPACE_CONTEXT_IGNORED_SUFFIXES: tuple[str, ...] = (
    '.pyc',
    '.pyo',
    '.tmp',
    '.swp',
)

NODE_MODULES_DIR_NAME = 'node_modules'

# Extra binary / non-text suffixes skipped by search_workspace (tool-specific)
SEARCH_SKIP_SUFFIXES: frozenset[str] = frozenset(
    {
        '.png',
        '.jpg',
        '.jpeg',
        '.gif',
        '.ico',
        '.pdf',
        '.zip',
        '.mp3',
        '.mp4',
        '.wav',
    }
)

_MAX_GITIGNORE_CACHE_ENTRIES = 256
_gitignore_cache: OrderedDict[str, tuple[int | float, list[str]]] = OrderedDict()


def normalize_context_path(target_path: str) -> str:
    return target_path.replace('\\', '/')


def load_workspace_ignore_rules(root: Path) -> list[str]:
    path = root / '.gitignore'
    try:
        raw = path.read_text(encoding='utf-8', errors='replace')
    except OSError:
        return []
    return [
        line
        for line in (ln.strip() for ln in raw.splitlines())
        if line and not line.startswith('#') and not line.startswith('!')
    ]


def get_workspace_ignore_rules_cached(root: Path) -> list[str]:
    root_resolved = root.resolve()
    key_base = str(root_resolved)
    gitignore = root_resolved / '.gitignore'
    try:
        st = gitignore.stat()
        mtime_key = getattr(st, 'st_mtime_ns', int(st.st_mtime * 1e9))
    except OSError:
        mtime_key = -1
    cached = _gitignore_cache.get(key_base)
    if cached is not None and cached[0] == mtime_key:
        _gitignore_cache.move_to_end(key_base)
        return cached[1]
    rules = load_workspace_ignore_rules(root_resolved)
    _gitignore_cache[key_base] = (mtime_key, rules)
    _gitignore_cache.move_to_end(key_base)
    while len(_gitignore_cache) > _MAX_GITIGNORE_CACHE_ENTRIES:
        _gitignore_cache.popitem(last=False)
    return rules


def matches_ignore_rule(relative_path: str, entry_name: str, rule: str) -> bool:
    normalized_path = normalize_context_path(relative_path)
    normalized_rule = normalize_context_path(rule)

    if not normalized_rule:
        return False

    if normalized_rule.endswith('/'):
        dir_rule = normalized_rule[:-1]
        return (
            normalized_path == dir_rule
            or normalized_path.startswith(f'{dir_rule}/')
            or entry_name == dir_rule
        )

    if normalized_rule.startswith('*.'):
        return entry_name.endswith(normalized_rule[1:])

    if '/' not in normalized_rule:
        return entry_name == normalized_rule or normalized_rule in normalized_path.split('/')

    anchored_rule = normalized_rule[1:] if normalized_rule.startswith('/') else normalized_rule
    return normalized_path == anchored_rule or normalized_path.startswith(f'{anchored_rule}/')


def workspace_expose_all_files() -> bool:
    """True when Settings → Tools disables workspace file filters for discovery tools."""
    return bool(getattr(runtime_config.tools, 'expose_all_workspace_files', False))


def is_log_related_file(entry_name: str) -> bool:
    """Log files stay visible in tree/list/search even when gitignore or built-in suffix rules apply."""
    lower = entry_name.lower()
    if lower.endswith('.log'):
        return True
    if lower.endswith(('.log.gz', '.log.bz2', '.log.xz', '.log.zip')):
        return True
    parts = lower.rsplit('.', 2)
    if len(parts) == 3 and parts[1] == 'log' and parts[2].isdigit():
        return True
    return False


def is_under_node_modules(relative_path: str) -> bool:
    normalized = normalize_context_path(relative_path).strip('/')
    if not normalized:
        return False
    return NODE_MODULES_DIR_NAME in normalized.split('/')


def is_node_modules_bulk_listing_path(relative_path: str) -> bool:
    """True when ``list_workspace_directory`` must not enumerate children (search instead)."""
    normalized = normalize_context_path(relative_path).strip('/')
    if not normalized:
        return False
    if normalized == NODE_MODULES_DIR_NAME:
        return True
    return normalized.startswith(f'{NODE_MODULES_DIR_NAME}/')


def should_ignore_workspace_entry(entry_name: str, relative_path: str, ignore_rules: list[str]) -> bool:
    """Bulk discovery (tree, list, semantic walk): hide ignored paths; never hide log files."""
    if is_log_related_file(entry_name):
        return False
    normalized = normalize_context_path(relative_path).strip('/')
    segments = normalized.split('/') if normalized else []
    if NODE_MODULES_DIR_NAME in segments:
        if segments == [NODE_MODULES_DIR_NAME] and entry_name == NODE_MODULES_DIR_NAME:
            return False
        return True
    if workspace_expose_all_files():
        return False
    if entry_name in WORKSPACE_CONTEXT_IGNORED_NAMES:
        return True
    if any(entry_name.endswith(sfx) for sfx in WORKSPACE_CONTEXT_IGNORED_SUFFIXES):
        return True
    return any(matches_ignore_rule(relative_path, entry_name, rule) for rule in ignore_rules)


def iter_workspace_search_files(root: Path, ignore_rules: list[str]) -> Iterator[Path]:
    """Top-down walk under root, pruning ignored directories; yield files not ignored and not in SEARCH_SKIP_SUFFIXES."""
    root = root.resolve()

    for dirpath, dirnames, filenames in os.walk(root, topdown=True):
        rdir = Path(dirpath)
        rel_dir_raw = rdir.relative_to(root).as_posix()
        rel_dir = '' if rel_dir_raw == '.' else rel_dir_raw

        kept: list[str] = []
        for d in dirnames:
            rel_path = f'{rel_dir}/{d}' if rel_dir else d
            if should_ignore_workspace_entry(d, rel_path, ignore_rules):
                continue
            kept.append(d)
        dirnames[:] = kept

        for fn in filenames:
            rel_path = f'{rel_dir}/{fn}' if rel_dir else fn
            if should_ignore_workspace_entry(fn, rel_path, ignore_rules):
                continue
            if not workspace_expose_all_files() and Path(fn).suffix.lower() in SEARCH_SKIP_SUFFIXES:
                continue
            yield rdir / fn
