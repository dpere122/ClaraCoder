"""In-memory source formatters (Black for ``.py``, Prettier for web sources) used by workspace edit tools."""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
from pathlib import Path

from clara_coder_backend.config import env_clara

logger = logging.getLogger('clara.formatters')

__all__ = ['format_python_source_str', 'format_source_via_prettier', 'resolve_prettier_cli']

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
    """Locate ``prettier.cjs`` or a ``prettier`` on PATH; optional ``CLARA_PRETTIER_CLI`` override."""

    override = (env_clara('CLARA_PRETTIER_CLI') or '').strip()
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
    n = (env_clara('CLARA_NODE_EXECUTABLE') or '').strip()
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
        return None, 'node executable not found (install Node.js or set CLARA_NODE_EXECUTABLE)'
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
        return None, 'prettier CLI not found (install in workspace or set CLARA_PRETTIER_CLI)'

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

    # Prettier echoes the input encoding back on stdout; decode with the same codec.
    out = (proc.stdout or b'').decode(source_encoding or 'utf-8', errors='replace')
    return out, ''


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
