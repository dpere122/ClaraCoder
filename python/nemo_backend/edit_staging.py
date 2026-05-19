"""Workspace edit staging under ``NEMO_STAGING_DIR`` for nested create/update specialists."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import uuid
from shutil import copy2
from pathlib import Path

from nemo_backend.lsp.file_policy import (
    CONFIG_CODE_REVIEW_EXTENSIONS,
    LEGACY_CODE_REVIEW_EXTENSIONS,
    requires_code_review,
)
from nemo_backend.workspace_ignore import get_workspace_ignore_rules_cached, should_ignore_workspace_entry
from nemo_backend.workspace_text_io import DiskNewline, decode_for_tools, encode_for_disk

logger = logging.getLogger('nemo.staging')

# Extensions that require code review before finalize (nested planning only).
CODE_REVIEW_EXTENSIONS: frozenset[str] = frozenset(
    {'.py', *LEGACY_CODE_REVIEW_EXTENSIONS, *CONFIG_CODE_REVIEW_EXTENSIONS}
)

_NODE_PRETTIER_SUFFIXES = {'.cjs', '.js', '.mjs'}
_NPM_PRETTIER_SHIM_NAMES = {'prettier', 'prettier.cmd', 'prettier.bat', 'prettier.ps1'}


def _prettier_bin_from_package(package_dir: Path) -> Path | None:
    package_dir = package_dir.resolve()
    package_json = package_dir / 'package.json'
    if package_json.is_file():
        try:
            meta = json.loads(package_json.read_text(encoding='utf-8'))
        except (OSError, json.JSONDecodeError):
            meta = {}
        bin_spec = meta.get('bin') if isinstance(meta, dict) else None
        rel_bin = ''
        if isinstance(bin_spec, str):
            rel_bin = bin_spec
        elif isinstance(bin_spec, dict):
            value = bin_spec.get('prettier')
            if isinstance(value, str):
                rel_bin = value
        if rel_bin:
            candidate = (package_dir / rel_bin).resolve()
            if candidate.is_file():
                return candidate

    for rel in ('bin/prettier.cjs', 'bin/prettier.js', 'prettier.cjs', 'prettier.js'):
        candidate = (package_dir / rel).resolve()
        if candidate.is_file():
            return candidate
    return None


def _prettier_bin_from_npm_shim(shim: Path) -> Path | None:
    if shim.name.lower() not in _NPM_PRETTIER_SHIM_NAMES or shim.parent.name != '.bin':
        return None
    return _prettier_bin_from_package(shim.parent.parent / 'prettier')


def _resolve_prettier_cli_path(path: Path) -> Path | None:
    if not path.is_file():
        return None
    resolved = path.resolve()
    return _prettier_bin_from_npm_shim(resolved) or resolved


def _iter_prettier_search_roots(workspace_root: Path):
    seen: set[Path] = set()

    cur = workspace_root.resolve()
    for _ in range(64):
        if cur not in seen:
            seen.add(cur)
            yield cur
        parent = cur.parent
        if parent == cur:
            break
        cur = parent

    # App-bundled fallback: packaged/runtime dependencies live near this backend,
    # not necessarily under the user's active workspace.
    for parent in Path(__file__).resolve().parents:
        if parent in seen:
            continue
        if (parent / 'package.json').is_file() or (parent / 'node_modules').is_dir():
            seen.add(parent)
            yield parent


def resolve_prettier_cli(workspace_root: Path) -> Path | None:
    """Locate ``prettier.cjs`` or a ``prettier`` on PATH; optional ``NEMO_PRETTIER_CLI`` override."""

    override = (os.environ.get('NEMO_PRETTIER_CLI') or '').strip()
    if override:
        p = Path(override).expanduser()
        resolved = _resolve_prettier_cli_path(p)
        if resolved is not None:
            return resolved
        which_override = shutil.which(override)
        if which_override:
            return _resolve_prettier_cli_path(Path(which_override))
        return None

    for root in _iter_prettier_search_roots(workspace_root):
        package_bin = _prettier_bin_from_package(root / 'node_modules' / 'prettier')
        if package_bin is not None:
            return package_bin
        shim_name = 'prettier.cmd' if os.name == 'nt' else 'prettier'
        shim = root / 'node_modules' / '.bin' / shim_name
        resolved = _resolve_prettier_cli_path(shim)
        if resolved is not None:
            return resolved

    which = shutil.which('prettier')
    if which:
        return _resolve_prettier_cli_path(Path(which))
    return None


def _resolve_node_executable() -> str | None:
    n = (os.environ.get('NEMO_NODE_EXECUTABLE') or '').strip()
    if n:
        if Path(n).is_file():
            return str(Path(n).resolve())
        w = shutil.which(n)
        return w
    return shutil.which('node')


def _prettier_command(prettier_cli: Path) -> tuple[list[str] | None, str]:
    if prettier_cli.suffix.lower() not in _NODE_PRETTIER_SUFFIXES:
        return [str(prettier_cli)], ''

    node = _resolve_node_executable()
    if not node:
        return None, 'node executable not found (install Node.js or set NEMO_NODE_EXECUTABLE)'
    return [node, str(prettier_cli)], ''


def format_source_via_prettier(
    text: str,
    *,
    workspace_root: Path,
    relative_posix: str,
    source_encoding: str = 'utf-8',
    timeout_sec: float = 60.0,
) -> tuple[str | None, str]:
    """Run Prettier on source via stdin; ``cwd`` is workspace root for config resolution."""

    prettier_cli = resolve_prettier_cli(workspace_root)
    if prettier_cli is None:
        return None, 'prettier CLI not found (install in workspace or set NEMO_PRETTIER_CLI)'

    prettier_command, command_err = _prettier_command(prettier_cli)
    if prettier_command is None:
        return None, command_err

    rel = relative_posix.strip().replace('\\', '/')
    cwd = str(workspace_root.resolve())
    try:
        input_bytes = text.encode(source_encoding or 'utf-8', errors='strict')
    except UnicodeEncodeError as exc:
        return None, f'encode for prettier stdin failed: {exc}'

    try:
        proc = subprocess.run(
            [*prettier_command, '--stdin-filepath', rel],
            input=input_bytes,
            capture_output=True,
            cwd=cwd,
            timeout=timeout_sec,
        )
    except subprocess.TimeoutExpired:
        return None, 'prettier timed out'
    except OSError as exc:
        logger.warning('prettier spawn failed err=%s', exc)
        return None, str(exc)

    if proc.returncode != 0:
        err = (proc.stderr or b'').decode('utf-8', errors='replace').strip() or str(proc.returncode)
        logger.warning('prettier failed rc=%s stderr_head=%s', proc.returncode, err[:500])
        return None, f'prettier exited {proc.returncode}: {err[:800]}'

    out = (proc.stdout or b'').decode('utf-8')
    return out, ''


def run_prettier_on_file(
    path: Path,
    *,
    workspace_root: Path,
    relative_posix: str,
    encoding: str,
    disk_newline: DiskNewline,
) -> tuple[bool, str]:
    """Run Prettier on ``path`` (read → format → write). Returns (ok, detail)."""

    try:
        src = read_staging_text(path, encoding)
    except OSError as exc:
        return False, f'read failed: {exc}'

    formatted, err = format_source_via_prettier(
        src, workspace_root=workspace_root, relative_posix=relative_posix, source_encoding=encoding or 'utf-8'
    )
    if formatted is None:
        return False, err

    try:
        write_staging_text(path, formatted, encoding, disk_newline)
    except OSError as exc:
        return False, f'write failed: {exc}'
    return True, 'formatted'


# Extensions that require code review before finalize (nested planning only).
CODE_REVIEW_EXTENSIONS: frozenset[str] = frozenset(
    {'.py', *LEGACY_CODE_REVIEW_EXTENSIONS, *CONFIG_CODE_REVIEW_EXTENSIONS}
)


def get_staging_root() -> Path:
    raw = os.environ.get('NEMO_STAGING_DIR', '').strip()
    if raw:
        return Path(raw).resolve()
    return Path(tempfile.gettempdir()).resolve() / 'nemo-wrapper-staging'


def is_code_review_extension(relative_posix_path: str) -> bool:
    return requires_code_review(relative_posix_path)


def _safe_staging_filename(rel_display: str) -> str:
    base = rel_display.strip().replace('\\', '/') or 'file'
    digest = hashlib.sha256(base.encode('utf-8')).hexdigest()[:16]
    leaf = Path(base).name
    leaf = re.sub(r'[^a-zA-Z0-9._-]+', '_', leaf)[:120] or 'file'
    return f'{digest}_{leaf}'


def _safe_staging_namespace(session_id: str, graph_id: str = '') -> str:
    base = re.sub(r'[^a-zA-Z0-9._-]+', '_', session_id)[:120] or 'session'
    if not graph_id:
        return base
    suffix = re.sub(r'[^a-zA-Z0-9._-]+', '_', graph_id)[:60] or 'graph'
    return f'{base}__{suffix}'


def _graph_session_dir(session_id: str, graph_id: str = '') -> Path:
    return get_staging_root() / _safe_staging_namespace(session_id, graph_id)


def graph_snapshot_root(session_id: str, graph_id: str) -> Path:
    return (_graph_session_dir(session_id, graph_id) / 'workspace-snapshot').resolve()


def allocate_staging_file(session_id: str, rel_display: str, *, graph_id: str = '') -> Path:
    session_dir = _graph_session_dir(session_id, graph_id) / 'drafts'
    session_dir.mkdir(parents=True, exist_ok=True)
    path = session_dir / _safe_staging_filename(rel_display)
    return path.resolve()


def write_staging_text(path: Path, text: str, encoding: str, disk_newline: DiskNewline) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = encode_for_disk(text, encoding, disk_newline)
    path.write_bytes(data)


def read_staging_text(path: Path, encoding: str) -> str:
    raw = path.read_bytes()
    return decode_for_tools(raw, encoding)


def format_python_source_str(text: str) -> tuple[str | None, str]:
    """Run Black on a source string. Returns ``(formatted, '')`` or ``(None, error_detail)``."""

    try:
        import black
    except ImportError:
        return None, 'black is not installed'
    try:
        formatted = black.format_str(text, mode=black.FileMode())
        return formatted, ''
    except Exception as exc:
        logger.warning('Black format_str failed err=%s', exc)
        return None, str(exc)


def run_black_on_file(path: Path, *, encoding: str, disk_newline: DiskNewline) -> tuple[bool, str]:
    """Run Black on ``path`` (in-memory format, then write). Returns (ok, detail)."""
    try:
        src = read_staging_text(path, encoding)
    except OSError as exc:
        return False, f'read failed: {exc}'

    formatted, err = format_python_source_str(src)
    if formatted is None:
        return False, err

    try:
        write_staging_text(path, formatted, encoding, disk_newline)
    except OSError as exc:
        return False, f'write failed: {exc}'
    return True, 'formatted'


def unlink_staging_quiet(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def discard_all_session_stagings(session: object) -> None:
    """Remove all pending staging entries for a session (unlink temps, clear dict)."""
    from pathlib import Path

    pending = getattr(session, 'pending_edit_stagings', None)
    if not isinstance(pending, dict):
        return
    for _rel, entry in list(pending.items()):
        tp = getattr(entry, 'temp_path', '') or ''
        if tp:
            unlink_staging_quiet(Path(tp))
    pending.clear()


def clear_session_staging_dir(session_id: str) -> None:
    """Remove every staging namespace for ``session_id`` (best effort)."""
    root = get_staging_root()
    prefix = _safe_staging_namespace(session_id)
    try:
        if not root.is_dir():
            return
        for sub in root.iterdir():
            if not sub.is_dir() or not sub.name.startswith(prefix):
                continue
            for p in sorted(sub.rglob('*'), reverse=True):
                try:
                    if p.is_file():
                        p.unlink()
                    elif p.is_dir():
                        p.rmdir()
                except OSError:
                    pass
            try:
                sub.rmdir()
            except OSError:
                pass
    except OSError:
        pass


def copy_workspace_mirror(
    content_root: Path,
    dest_root: Path,
    *,
    rules_workspace: Path,
) -> None:
    """Copy from ``content_root`` into ``dest_root`` using ignore rules from ``rules_workspace`` (same relative paths)."""

    content_root = content_root.resolve()
    dest_root = dest_root.resolve()
    rules_workspace = rules_workspace.resolve()
    ignore_rules = get_workspace_ignore_rules_cached(rules_workspace)
    dest_root.mkdir(parents=True, exist_ok=True)

    for dirpath, dirnames, filenames in os.walk(content_root, topdown=True):
        src_dir = Path(dirpath)
        rel_dir_raw = src_dir.relative_to(content_root).as_posix()
        rel_dir = '' if rel_dir_raw == '.' else rel_dir_raw

        kept_dirs: list[str] = []
        for dirname in dirnames:
            rel_path = f'{rel_dir}/{dirname}' if rel_dir else dirname
            if should_ignore_workspace_entry(dirname, rel_path, ignore_rules):
                continue
            kept_dirs.append(dirname)
            (dest_root / rel_path).mkdir(parents=True, exist_ok=True)
        dirnames[:] = kept_dirs

        for filename in filenames:
            rel_path = f'{rel_dir}/{filename}' if rel_dir else filename
            if should_ignore_workspace_entry(filename, rel_path, ignore_rules):
                continue
            source = src_dir / filename
            target = dest_root / rel_path
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                copy2(source, target)
            except OSError as exc:
                logger.warning(
                    'workspace mirror: skipped copy (unreadable or uncopyable) rel=%s err=%s',
                    rel_path,
                    exc,
                )


def copy_workspace_into_snapshot(workspace_root: Path, snapshot_root: Path) -> None:
    """Materialize an ignored-aware workspace mirror under ``snapshot_root``."""
    copy_workspace_mirror(workspace_root, snapshot_root, rules_workspace=workspace_root)


def begin_staging_snapshot_session(session: object, session_id: str, workspace_root: Path) -> str:
    """Reset staging state, then seed a fresh workspace mirror for this session."""
    discard_all_session_stagings(session)
    setattr(session, 'test_run_materializations', {})
    clear_session_staging_dir(session_id)

    snapshot_id = uuid.uuid4().hex[:12]
    snapshot_root = graph_snapshot_root(session_id, snapshot_id)
    copy_workspace_into_snapshot(workspace_root, snapshot_root)

    setattr(session, 'active_staging_snapshot_id', snapshot_id)
    setattr(session, 'active_staging_snapshot_root', str(snapshot_root))
    return snapshot_id


def get_active_staging_snapshot_root(session: object) -> Path | None:
    raw = str(getattr(session, 'active_staging_snapshot_root', '') or '').strip()
    if not raw:
        return None
    return Path(raw).resolve()


def write_snapshot_file(session: object, relative_path: str, text: str, encoding: str, disk_newline: DiskNewline) -> None:
    """Keep the active workspace mirror in sync with the latest approved or staged file content."""
    snapshot_root = get_active_staging_snapshot_root(session)
    if snapshot_root is None:
        return
    rel = relative_path.strip().replace('\\', '/')
    if not rel:
        return
    target = (snapshot_root / rel).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    write_staging_text(target, text, encoding, disk_newline)


def delete_snapshot_path(session: object, relative_path: str) -> None:
    """Remove a path from the active workspace mirror when the real workspace deletes it."""
    snapshot_root = get_active_staging_snapshot_root(session)
    if snapshot_root is None:
        return
    rel = relative_path.strip().replace('\\', '/')
    if not rel:
        return
    target = (snapshot_root / rel).resolve()
    if target.is_file() or target.is_symlink():
        unlink_staging_quiet(target)
    current = target.parent
    while current != snapshot_root and current.is_dir():
        try:
            current.rmdir()
        except OSError:
            break
        current = current.parent
