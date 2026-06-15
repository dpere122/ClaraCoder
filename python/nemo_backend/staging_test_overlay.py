"""Ephemeral workspace mirror + staged drafts for pre-transfer command runs."""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
from typing import TYPE_CHECKING

from nemo_backend.edit_staging import (
    copy_workspace_mirror,
    get_active_staging_snapshot_root,
    get_staging_root,
)
from nemo_backend.lsp.typescript_project_root import package_node_modules_link_rels
from nemo_backend.workspace_text_io import DiskNewline, write_file_resolved

if TYPE_CHECKING:
    from nemo_backend.domain import SessionState

logger = logging.getLogger('nemo.staging_overlay')

_DEFAULT_LINK_RELS: tuple[str, ...] = (
    '.venv',
    'node_modules',
    'python/node_modules',
    'src/renderer/node_modules',
)


def _safe_session_ns(session_id: str) -> str:
    return re.sub(r'[^a-zA-Z0-9._-]+', '_', session_id)[:120] or 'session'


def _link_dir_windows_junction(target: Path, link: Path) -> tuple[bool, str]:
    target_s = str(target.resolve())
    link_s = str(link.resolve())
    try:
        proc = subprocess.run(
            ['cmd', '/c', 'mklink', '/J', link_s, target_s],
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode == 0:
            return True, ''
        err = (proc.stderr or proc.stdout or '').strip() or f'exit {proc.returncode}'
        return False, err
    except OSError as exc:
        return False, str(exc)


def link_workspace_dependency_into_overlay(
    workspace_root: Path,
    overlay_root: Path,
    rel_posix: str,
) -> tuple[bool, str]:
    """Point overlay_root/rel at workspace_root/rel when the source exists (symlink or Windows junction)."""
    rel = rel_posix.strip().replace('\\', '/').strip('/')
    if not rel or '..' in rel.split('/'):
        return False, f'Invalid dependency relative path `{rel_posix}`.'
    ws_resolved = workspace_root.resolve()
    ov_resolved = overlay_root.resolve()
    src = (ws_resolved / rel).resolve()
    dst = (ov_resolved / rel).resolve()
    try:
        dst.relative_to(ov_resolved)
    except ValueError:
        return False, 'Overlay link path escapes overlay root.'
    try:
        src.relative_to(ws_resolved)
    except ValueError:
        return False, 'Dependency link source escapes workspace root.'
    if not src.exists():
        return True, ''
    if dst.exists() or dst.is_symlink():
        return True, ''
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.symlink(src, dst, target_is_directory=src.is_dir())
        return True, ''
    except OSError as exc:
        if sys.platform.startswith('win') and src.is_dir():
            ok, detail = _link_dir_windows_junction(src, dst)
            if ok:
                return True, ''
            return False, f'Could not symlink or junction `{rel}`: {exc}; {detail}'
        return False, f'Could not symlink `{rel}`: {exc}'


def _workspace_applied(entry: object) -> bool:
    v = getattr(entry, 'workspace_applied', False)
    return v if isinstance(v, bool) else False


def apply_pending_staged_merged_texts(session: SessionState, overlay_root: Path) -> tuple[bool, str]:
    """Write each pending staging draft into the overlay mirror."""
    overlay_resolved = overlay_root.resolve()
    pending = getattr(session, 'pending_edit_stagings', None)
    if not isinstance(pending, dict):
        return True, ''
    for rel_key, entry in list(pending.items()):
        if _workspace_applied(entry):
            continue
        rel = str(rel_key).strip().replace('\\', '/')
        if not rel or '..' in rel.split('/'):
            return False, f'Invalid staged path `{rel_key}`.'
        target = (overlay_resolved / rel).resolve()
        try:
            target.relative_to(overlay_resolved)
        except ValueError:
            return False, f'Staged path `{rel}` escapes overlay root.'
        merged = str(getattr(entry, 'merged_text', '') or '')
        enc = str(getattr(entry, 'disk_encoding', '') or 'utf-8')
        nl_raw = str(getattr(entry, 'disk_newline', '') or 'lf').lower()
        nl: DiskNewline = 'crlf' if nl_raw == 'crlf' else 'lf'
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            write_file_resolved(target, merged, enc, nl)
        except OSError as exc:
            return False, f'Could not write staged overlay for `{rel}`: {exc}'
        except Exception as exc:
            return False, f'Could not encode staged overlay for `{rel}`: {exc}'
    return True, ''


def build_staging_workspace_overlay(
    session: SessionState,
    workspace_root: Path,
    session_id: str,
    *,
    overlay_subdir: str,
    extra_dependency_rels: tuple[str, ...] | None = None,
) -> tuple[Path | None, Path | None, str]:
    """Return ``(overlay_root, overlay_parent, err)``; ``overlay_parent`` is the uuid folder to rmtree.

    Baseline tree is the active staging snapshot when present, else the live workspace.
    ``overlay_root`` is ``.../uuid/workspace`` — the synthetic workspace root (LSP rootUri / subprocess cwd).
    """
    ws = workspace_root.resolve()
    snap = get_active_staging_snapshot_root(session)
    content_root = snap if snap is not None and snap.is_dir() else ws
    ns = _safe_session_ns(session_id)
    overlay_parent = get_staging_root() / ns / overlay_subdir / uuid.uuid4().hex
    overlay_root = overlay_parent / 'workspace'
    try:
        overlay_root.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        return None, None, f'Could not create overlay directory ({exc}).'

    try:
        copy_workspace_mirror(content_root, overlay_root, rules_workspace=ws)
        ordered: list[str] = []
        seen: set[str] = set()
        auto_nm = package_node_modules_link_rels(ws)
        for rel in (*_DEFAULT_LINK_RELS, *auto_nm, *(extra_dependency_rels or ())):
            rel_clean = rel.strip().replace('\\', '/').strip('/')
            if not rel_clean or rel_clean in seen:
                continue
            seen.add(rel_clean)
            ordered.append(rel_clean)
        for rel_clean in ordered:
            ok, msg = link_workspace_dependency_into_overlay(ws, overlay_root, rel_clean)
            if not ok:
                shutil.rmtree(overlay_parent, ignore_errors=True)
                return None, None, msg or f'Failed to link dependency `{rel_clean}`.'
        ok2, err2 = apply_pending_staged_merged_texts(session, overlay_root)
        if not ok2:
            shutil.rmtree(overlay_parent, ignore_errors=True)
            return None, None, err2
    except Exception as exc:
        shutil.rmtree(overlay_parent, ignore_errors=True)
        logger.exception('build_staging_workspace_overlay failed subdir=%s', overlay_subdir)
        return None, None, str(exc)

    return overlay_root, overlay_parent, ''


def build_staging_test_overlay(
    session: SessionState,
    workspace_root: Path,
    session_id: str,
    *,
    extra_dependency_rels: tuple[str, ...] | None = None,
) -> tuple[Path | None, Path | None, str]:
    """Return ``(overlay_root, overlay_parent, err)``; ``overlay_parent`` is the uuid folder to rmtree.

    ``overlay_root`` is ``.../uuid/workspace`` — the synthetic workspace root for subprocess ``cwd``.
    """
    return build_staging_workspace_overlay(
        session,
        workspace_root,
        session_id,
        overlay_subdir='test-overlay',
        extra_dependency_rels=extra_dependency_rels,
    )


def remove_overlay_parent(overlay_parent: Path | None) -> None:
    if overlay_parent is None:
        return
    try:
        shutil.rmtree(overlay_parent, ignore_errors=True)
    except OSError:
        pass


def clear_lsp_staging_overlay(session: SessionState) -> None:
    """Remove on-disk LSP overlay and clear session pointers."""

    raw = str(getattr(session, 'lsp_staging_overlay_parent', '') or '').strip()
    if raw:
        remove_overlay_parent(Path(raw))
    session.lsp_staging_overlay_root = ''
    session.lsp_staging_overlay_parent = ''


def ensure_lsp_staging_overlay(session: SessionState, workspace_root: Path, *, session_id: str | None = None) -> Path:
    """Return the overlay workspace root, refreshing merged staging files on disk."""

    from nemo_backend.state import current_session_id

    sid = (session_id or current_session_id.get() or '').strip()
    if not sid:
        raise ValueError('No active session for LSP staging overlay.')
    ws = workspace_root.resolve()
    existing = str(getattr(session, 'lsp_staging_overlay_root', '') or '').strip()
    if existing:
        root = Path(existing)
        if root.is_dir():
            ok, err = apply_pending_staged_merged_texts(session, root)
            if ok:
                return root.resolve()
            logger.warning('lsp staging overlay incremental refresh failed; rebuilding: %s', err)
            clear_lsp_staging_overlay(session)

    overlay_root, overlay_parent, err_msg = build_staging_workspace_overlay(
        session,
        ws,
        sid,
        overlay_subdir='lsp-overlay',
    )
    if overlay_root is None or err_msg:
        raise ValueError(err_msg or 'Could not build LSP staging overlay.')
    session.lsp_staging_overlay_root = str(overlay_root.resolve())
    session.lsp_staging_overlay_parent = str(overlay_parent.resolve()) if overlay_parent else ''
    return overlay_root.resolve()


_MAX_OVERLAY_ARGV_LEN = 64
_MAX_OVERLAY_ARG_LEN = 512
_FORBIDDEN_SUBPROCESS_CHARS = frozenset(';|&$`\n\r<>()')

_SHELL_EXECUTABLES = frozenset(
    {
        'bash',
        'cscript',
        'csh',
        'cmd',
        'fish',
        'ksh',
        'msiexec',
        'powershell',
        'pwsh',
        'sh',
        'tcsh',
        'wscript',
        'zsh',
    }
)

_OVERLAY_EXECUTABLE_ALLOWLIST = frozenset(
    {
        'black',
        'bun',
        'cargo',
        'cmake',
        'dotnet',
        'eslint',
        'flake8',
        'go',
        'gradle',
        'gradlew',
        'isort',
        'jest',
        'make',
        'mocha',
        'mvn',
        'mvnw',
        'mypy',
        'ninja',
        'node',
        'npm',
        'npx',
        'pnpm',
        'py',
        'pylint',
        'pytest',
        'python',
        'python3',
        'ruff',
        'tsc',
        'vitest',
        'yarn',
    }
)

_PM_EXECUTABLES = frozenset({'bun', 'npm', 'npx', 'pnpm', 'yarn'})
_PM_ALLOWED_SUBCOMMANDS = frozenset(
    {
        'audit',
        'build',
        'check',
        'ci',
        'exec',
        'lint',
        'outdated',
        'run',
        'start',
        'test',
        'why',
    }
)
_PM_BLOCKED_SUBCOMMANDS = frozenset(
    {
        'access',
        'add',
        'create',
        'dedupe',
        'deprecate',
        'fund',
        'hook',
        'i',
        'init',
        'install',
        'link',
        'login',
        'logout',
        'owner',
        'pack',
        'profile',
        'publish',
        'remove',
        'rm',
        'set',
        'team',
        'token',
        'un',
        'unlink',
        'uninstall',
        'update',
        'upgrade',
    }
)

_NPX_ALLOWED_TOOLS = frozenset(
    {
        'eslint',
        'jest',
        'mocha',
        'tsc',
        'vite',
        'vitest',
        'webpack',
        'webpack-dev-server',
    }
)

_PYTHON_M_ALLOWLIST = frozenset(
    {
        'black',
        'compileall',
        'coverage',
        'flake8',
        'isort',
        'mypy',
        'nox',
        'pylint',
        'pytest',
        'ruff',
        'tox',
        'unittest',
    }
)

_SCRIPT_EXTENSIONS = frozenset({'.cjs', '.js', '.mjs', '.py'})


def _overlay_executable_basename(argv0: str) -> str:
    name = Path(str(argv0).replace('\\', '/')).name
    if sys.platform.startswith('win'):
        for ext in ('.exe', '.cmd', '.bat', '.com', '.ps1'):
            if name.lower().endswith(ext):
                return name[: -len(ext)].lower()
    return name.lower()


def _overlay_arg_has_path_traversal(arg: str) -> bool:
    return '..' in str(arg).replace('\\', '/').split('/')


def _overlay_is_relative_script_path(arg: str) -> bool:
    s = str(arg).replace('\\', '/')
    if not s or s.startswith(('/', '-')):
        return False
    if re.match(r'^[A-Za-z]:/', s):
        return False
    return Path(s).suffix.lower() in _SCRIPT_EXTENSIONS


def validate_overlay_command_argv(argv: list[str]) -> tuple[list[str] | None, str]:
    """Reject overlay commands outside test/build/lint runners (no shells or inline code)."""

    if not argv:
        return None, 'Tool error: command argv must be non-empty.'
    if len(argv) > _MAX_OVERLAY_ARGV_LEN:
        return None, f'Tool error: at most {_MAX_OVERLAY_ARGV_LEN} argv entries are allowed.'
    for i, raw in enumerate(argv):
        if not isinstance(raw, str):
            return None, f'Tool error: argv[{i}] must be a string.'
        if not raw.strip():
            return None, f'Tool error: argv[{i}] is empty.'
        if len(raw) > _MAX_OVERLAY_ARG_LEN:
            return None, f'Tool error: argv[{i}] exceeds {_MAX_OVERLAY_ARG_LEN} characters.'
        if _overlay_arg_has_path_traversal(raw):
            return None, f'Tool error: argv[{i}] must not contain `..` path segments.'

    exe = _overlay_executable_basename(argv[0])
    if exe in _SHELL_EXECUTABLES:
        return None, 'Tool error: shell interpreters are not allowed in staging overlay commands.'
    if exe not in _OVERLAY_EXECUTABLE_ALLOWLIST:
        return (
            None,
            'Tool error: staging overlay commands may only invoke test/build/lint runners '
            f'(got `{argv[0]}`). Prefer `run_workspace_pytest_tests`, `run_workspace_python_smoke_test`, '
            'or `run_workspace_node_smoke_test` when those suffice.',
        )

    if exe in {'python', 'python3', 'py'}:
        if '-c' in argv:
            return None, 'Tool error: `python -c` inline code is not allowed in staging overlay commands.'
        if '-m' in argv:
            idx = argv.index('-m')
            if idx + 1 >= len(argv):
                return None, 'Tool error: `python -m` requires a module name.'
            module = argv[idx + 1].split('.')[0].lower()
            if module not in _PYTHON_M_ALLOWLIST:
                return (
                    None,
                    'Tool error: `python -m` is limited to test/lint modules '
                    f'(got `{argv[idx + 1]}`). Allowed: {", ".join(sorted(_PYTHON_M_ALLOWLIST))}.',
                )
        elif len(argv) >= 2 and not _overlay_is_relative_script_path(argv[1]):
            return (
                None,
                'Tool error: python overlay commands must use `-m <module>` or a relative `.py` script path.',
            )

    if exe == 'node':
        for flag in ('-e', '--eval', '-p', '--print'):
            if flag in argv:
                return None, 'Tool error: `node -e` / `--eval` inline code is not allowed in staging overlay commands.'
        if len(argv) >= 2 and not _overlay_is_relative_script_path(argv[1]):
            return None, 'Tool error: node overlay commands must run a relative `.js`/`.mjs`/`.cjs` script path.'

    if exe in _PM_EXECUTABLES:
        if len(argv) < 2:
            return None, f'Tool error: `{exe}` requires a subcommand (e.g. `run`, `test`, `build`).'
        sub = argv[1].lower()
        if sub in _PM_BLOCKED_SUBCOMMANDS:
            return (
                None,
                f'Tool error: `{exe} {sub}` mutates dependencies or publishes packages and is not allowed '
                'in staging overlay commands.',
            )
        if exe == 'npx':
            tool_idx = 1
            while tool_idx < len(argv) and argv[tool_idx].startswith('-'):
                tool_idx += 1
            if tool_idx >= len(argv):
                return None, 'Tool error: `npx` requires a package or binary name.'
            tool = _overlay_executable_basename(argv[tool_idx])
            if tool not in _NPX_ALLOWED_TOOLS:
                return (
                    None,
                    'Tool error: `npx` is limited to common test/build tools '
                    f'(got `{argv[tool_idx]}`). Allowed: {", ".join(sorted(_NPX_ALLOWED_TOOLS))}.',
                )
        elif sub not in _PM_ALLOWED_SUBCOMMANDS:
            return (
                None,
                f'Tool error: `{exe} {sub}` is not allowed in staging overlay commands. '
                f'Allowed subcommands: {", ".join(sorted(_PM_ALLOWED_SUBCOMMANDS))}.',
            )

    for i, raw in enumerate(argv):
        if any(ch in raw for ch in _FORBIDDEN_SUBPROCESS_CHARS):
            return None, f'Tool error: argv[{i}] contains disallowed shell metacharacters.'
        if '\t' in raw:
            return None, f'Tool error: argv[{i}] contains tabs.'

    return argv, ''


def parse_command_argv_json(raw: str) -> tuple[list[str] | None, str]:
    """Parse ``command_argv_json`` as a JSON array of strings for ``create_subprocess_exec``."""
    s = (raw or '').strip()
    if not s:
        return None, 'Tool error: command_argv_json is empty.'
    try:
        parsed = json.loads(s)
    except json.JSONDecodeError as exc:
        return None, f'Tool error: command_argv_json is not valid JSON ({exc}).'
    if not isinstance(parsed, list):
        return None, 'Tool error: command_argv_json must be a JSON array of strings.'
    argv: list[str] = []
    for i, item in enumerate(parsed):
        if not isinstance(item, str):
            return None, f'Tool error: argv[{i}] must be a string.'
        if item == '':
            return None, f'Tool error: argv[{i}] is empty.'
        argv.append(item)
    if not argv:
        return None, 'Tool error: command argv must be non-empty.'
    return argv, ''


def resolve_overlay_cwd(overlay_root: Path, cwd_relative: str) -> tuple[Path | None, str]:
    """Resolve ``cwd_relative`` (posix, relative to overlay root) to an absolute cwd under the overlay."""
    rel = (cwd_relative or '').strip().replace('\\', '/').strip('/')
    ov = overlay_root.resolve()
    if not rel:
        return ov, ''
    if '..' in rel.split('/'):
        return None, 'Tool error: cwd_relative must not contain `..`.'
    cwd = (ov / rel).resolve()
    try:
        cwd.relative_to(ov)
    except ValueError:
        return None, 'Tool error: cwd_relative escapes the overlay root.'
    return cwd, ''
