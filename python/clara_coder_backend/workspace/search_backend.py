"""Shared grep/rg-backed search helpers with safe Python fallback hooks.

Stdout is streamed with early process kill once ``max_matches`` is reached, and a
hard byte budget caps peak RAM even when match counting fails.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger('clara.search')

_GREP_SAFE_ENCODINGS = frozenset(
    {
        '',
        'ascii',
        'cp1252',
        'latin-1',
        'utf-8',
        'utf-8-sig',
    }
)
_MAX_GREP_COMMAND_CHARS = 24_000
# Avoid hung backend when grep blocks on huge trees or pathological I/O.
_GREP_SUBPROCESS_TIMEOUT_SEC = 120.0
# Hard cap on streamed stdout so pathological trees cannot balloon RSS.
_MAX_SEARCH_STDOUT_BYTES = 12 * 1024 * 1024
_STDOUT_READ_CHUNK = 64 * 1024
_NODE_MODULES_DIR = 'node_modules'


@dataclass(frozen=True)
class SearchCandidate:
    command_path: str
    display_path: str


@dataclass(frozen=True)
class SearchLineMatch:
    display_path: str
    line_number: int


def run_grep_workspace_recursive(
    root: Path,
    query: str,
    *,
    max_matches: int,
    encoding: str = '',
    exclude_dir_names: frozenset[str] | None = None,
    include_node_modules: bool = False,
) -> list[SearchLineMatch] | None:
    """Recursive workspace search via ``rg`` (preferred) or ``grep``.

    ``node_modules`` is excluded by default. Pass ``include_node_modules=True`` when
    Settings → Tools exposes all workspace files.
    """

    if max_matches <= 0:
        return []
    if not _grep_can_search(query, encoding=encoding):
        return None

    exclude_names = set(exclude_dir_names or frozenset())
    if include_node_modules:
        exclude_names.discard(_NODE_MODULES_DIR)
    else:
        exclude_names.add(_NODE_MODULES_DIR)

    root_resolved = root.resolve()
    rg_executable = shutil.which('rg')
    if rg_executable is not None:
        args = _rg_recursive_args(rg_executable, query, exclude_names)
        matches = _run_search_streaming(
            args,
            cwd=root_resolved,
            max_matches=max_matches,
            display_by_command_path={},
            root_resolved=root_resolved,
            normalize_to_workspace_rel=True,
        )
        if matches is not None:
            return matches

    grep_executable = shutil.which('grep')
    if grep_executable is None:
        return None
    args = _grep_recursive_args(grep_executable, query, exclude_names)
    return _run_search_streaming(
        args,
        cwd=root_resolved,
        max_matches=max_matches,
        display_by_command_path={},
        root_resolved=root_resolved,
        normalize_to_workspace_rel=True,
    )


def run_grep_line_search(
    query: str,
    candidates: list[SearchCandidate],
    *,
    max_matches: int,
    encoding: str = '',
    cwd: Path | None = None,
) -> list[SearchLineMatch] | None:
    """Return line matches for explicit candidate paths, or ``None`` when search cannot run."""

    if not candidates or max_matches <= 0:
        return []
    if not _grep_can_search(query, encoding=encoding):
        return None

    display_by_command_path = {candidate.command_path: candidate.display_path for candidate in candidates}
    matches: list[SearchLineMatch] = []
    rg_executable = shutil.which('rg')
    grep_executable = shutil.which('grep')
    if rg_executable is None and grep_executable is None:
        return None

    for chunk in _chunk_candidates(candidates):
        remaining = max_matches - len(matches)
        if remaining <= 0:
            break
        chunk_paths = [candidate.command_path for candidate in chunk]
        if rg_executable is not None:
            args = [
                rg_executable,
                '-n',
                '-i',
                '--no-heading',
                '-0',
                '--no-config',
                '-e',
                query,
                *chunk_paths,
            ]
            chunk_matches = _run_search_streaming(
                args,
                cwd=cwd,
                max_matches=remaining,
                display_by_command_path=display_by_command_path,
                root_resolved=None,
                normalize_to_workspace_rel=False,
            )
            if chunk_matches is None and grep_executable is not None:
                args = [
                    grep_executable,
                    '-nH',
                    '-I',
                    '-i',
                    '-E',
                    '-Z',
                    '-e',
                    query,
                    *chunk_paths,
                ]
                chunk_matches = _run_search_streaming(
                    args,
                    cwd=cwd,
                    max_matches=remaining,
                    display_by_command_path=display_by_command_path,
                    root_resolved=None,
                    normalize_to_workspace_rel=False,
                )
        else:
            assert grep_executable is not None
            args = [
                grep_executable,
                '-nH',
                '-I',
                '-i',
                '-E',
                '-Z',
                '-e',
                query,
                *chunk_paths,
            ]
            chunk_matches = _run_search_streaming(
                args,
                cwd=cwd,
                max_matches=remaining,
                display_by_command_path=display_by_command_path,
                root_resolved=None,
                normalize_to_workspace_rel=False,
            )
        if chunk_matches is None:
            return None
        matches.extend(chunk_matches)
        if len(matches) >= max_matches:
            return matches[:max_matches]
    return matches


def _rg_recursive_args(rg_executable: str, query: str, exclude_names: set[str]) -> list[str]:
    args = [
        rg_executable,
        '-n',
        '-i',
        '--no-heading',
        '-0',
        '--hidden',
        '--no-config',
        '-e',
        query,
    ]
    for name in sorted(exclude_names):
        args.extend(['--glob', f'!**/{name}/**'])
    args.append('.')
    return args


def _grep_recursive_args(grep_executable: str, query: str, exclude_names: set[str]) -> list[str]:
    args = [grep_executable, '-rnH', '-I', '-i', '-E', '-Z', '-e', query]
    for name in sorted(exclude_names):
        args.append(f'--exclude-dir={name}')
    args.append('.')
    return args


def _grep_can_search(query: str, *, encoding: str) -> bool:
    normalized_encoding = (encoding or '').strip().lower()
    if normalized_encoding not in _GREP_SAFE_ENCODINGS:
        return False
    return '\x00' not in query and '\n' not in query and '\r' not in query


def _chunk_candidates(candidates: list[SearchCandidate]) -> list[list[SearchCandidate]]:
    chunks: list[list[SearchCandidate]] = []
    current: list[SearchCandidate] = []
    current_chars = 0
    for candidate in candidates:
        candidate_chars = max(1, len(candidate.command_path)) + 1
        if current and current_chars + candidate_chars > _MAX_GREP_COMMAND_CHARS:
            chunks.append(current)
            current = []
            current_chars = 0
        current.append(candidate)
        current_chars += candidate_chars
    if current:
        chunks.append(current)
    return chunks


def _normalize_match_path(
    command_path: str,
    *,
    display_by_command_path: dict[str, str],
    root_resolved: Path | None,
    normalize_to_workspace_rel: bool,
) -> str:
    if not normalize_to_workspace_rel or root_resolved is None:
        return display_by_command_path.get(command_path, command_path)
    raw = command_path.lstrip('./').replace('\\', '/')
    try:
        return Path(raw).resolve().relative_to(root_resolved).as_posix()
    except ValueError:
        return raw


def _parse_match_records_from_buffer(
    buf: bytes,
    *,
    display_by_command_path: dict[str, str],
    root_resolved: Path | None,
    normalize_to_workspace_rel: bool,
    max_matches: int,
) -> tuple[list[SearchLineMatch], bytes]:
    """Parse complete NUL-delimited path + line records; return matches and leftover bytes."""

    matches: list[SearchLineMatch] = []
    cursor = 0
    total = len(buf)
    while len(matches) < max_matches and cursor < total:
        nul = buf.find(b'\0', cursor)
        if nul == -1:
            break
        newline = buf.find(b'\n', nul + 1)
        if newline == -1:
            break
        command_path = buf[cursor:nul].decode(errors='replace')
        payload = buf[nul + 1 : newline]
        first_colon = payload.find(b':')
        if first_colon != -1:
            try:
                line_number = int(payload[:first_colon].decode('ascii', errors='strict'))
            except ValueError:
                line_number = -1
            if line_number > 0:
                matches.append(
                    SearchLineMatch(
                        display_path=_normalize_match_path(
                            command_path,
                            display_by_command_path=display_by_command_path,
                            root_resolved=root_resolved,
                            normalize_to_workspace_rel=normalize_to_workspace_rel,
                        ),
                        line_number=line_number,
                    )
                )
        cursor = newline + 1
    return matches, buf[cursor:]


def _terminate_process(proc: subprocess.Popen[bytes]) -> None:
    if proc.poll() is not None:
        return
    try:
        proc.kill()
    except OSError:
        pass
    try:
        proc.wait(timeout=2.0)
    except (OSError, subprocess.TimeoutExpired):
        pass


def _run_search_streaming(
    args: list[str],
    *,
    cwd: Path | None,
    max_matches: int,
    display_by_command_path: dict[str, str],
    root_resolved: Path | None,
    normalize_to_workspace_rel: bool,
) -> list[SearchLineMatch] | None:
    """Stream NUL-separated search stdout; stop early at ``max_matches`` or byte budget."""

    if max_matches <= 0:
        return []
    try:
        proc = subprocess.Popen(
            args,
            cwd=str(cwd) if cwd is not None else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=False,
        )
    except OSError as exc:
        logger.debug('search launch failed err=%s', exc)
        return None

    assert proc.stdout is not None
    matches: list[SearchLineMatch] = []
    leftover = b''
    total_read = 0
    deadline = time.monotonic() + _GREP_SUBPROCESS_TIMEOUT_SEC
    hit_byte_budget = False
    try:
        while len(matches) < max_matches:
            if time.monotonic() > deadline:
                logger.debug('search timed out after streaming partial results')
                _terminate_process(proc)
                return None
            chunk = proc.stdout.read(_STDOUT_READ_CHUNK)
            if not chunk:
                break
            total_read += len(chunk)
            if total_read > _MAX_SEARCH_STDOUT_BYTES:
                hit_byte_budget = True
                leftover += chunk[: max(0, _MAX_SEARCH_STDOUT_BYTES - (total_read - len(chunk)))]
                break
            leftover += chunk
            parsed, leftover = _parse_match_records_from_buffer(
                leftover,
                display_by_command_path=display_by_command_path,
                root_resolved=root_resolved,
                normalize_to_workspace_rel=normalize_to_workspace_rel,
                max_matches=max_matches - len(matches),
            )
            matches.extend(parsed)
            if len(matches) >= max_matches:
                break

        if leftover and len(matches) < max_matches and not hit_byte_budget:
            # Final incomplete-less flush: tolerate trailing record without newline at EOF.
            if b'\0' in leftover and b'\n' not in leftover[leftover.find(b'\0') :]:
                leftover = leftover + b'\n'
            parsed, _ = _parse_match_records_from_buffer(
                leftover,
                display_by_command_path=display_by_command_path,
                root_resolved=root_resolved,
                normalize_to_workspace_rel=normalize_to_workspace_rel,
                max_matches=max_matches - len(matches),
            )
            matches.extend(parsed)

        if len(matches) >= max_matches or hit_byte_budget:
            _terminate_process(proc)
        else:
            try:
                stderr = proc.stderr.read() if proc.stderr is not None else b''
            except OSError:
                stderr = b''
            try:
                returncode = proc.wait(timeout=max(0.1, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                logger.debug('search wait timed out')
                _terminate_process(proc)
                return None
            if returncode not in {0, 1}:
                err = stderr.decode('utf-8', errors='replace').strip()
                logger.debug('search failed code=%s stderr=%s', returncode, err)
                return None
    finally:
        if proc.poll() is None:
            _terminate_process(proc)
        if proc.stdout is not None:
            try:
                proc.stdout.close()
            except OSError:
                pass
        if proc.stderr is not None:
            try:
                proc.stderr.close()
            except OSError:
                pass

    return matches[:max_matches]


def _parse_grep_matches(stdout: bytes, display_by_command_path: dict[str, str]) -> list[SearchLineMatch]:
    """Parse a complete grep/rg NUL-separated stdout blob (tests / legacy callers)."""

    matches, leftover = _parse_match_records_from_buffer(
        stdout,
        display_by_command_path=display_by_command_path,
        root_resolved=None,
        normalize_to_workspace_rel=False,
        max_matches=10_000_000,
    )
    if leftover and b'\0' in leftover:
        padded = leftover if leftover.endswith(b'\n') else leftover + b'\n'
        extra, _ = _parse_match_records_from_buffer(
            padded,
            display_by_command_path=display_by_command_path,
            root_resolved=None,
            normalize_to_workspace_rel=False,
            max_matches=10_000_000,
        )
        matches.extend(extra)
    return matches
