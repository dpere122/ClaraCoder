"""Shared grep-backed search helpers with safe Python fallback hooks."""

from __future__ import annotations

import logging
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger('nemo.search')

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


@dataclass(frozen=True)
class SearchCandidate:
    command_path: str
    display_path: str


@dataclass(frozen=True)
class SearchLineMatch:
    display_path: str
    line_number: int


def run_grep_line_search(
    query: str,
    candidates: list[SearchCandidate],
    *,
    max_matches: int,
    encoding: str = '',
    cwd: Path | None = None,
) -> list[SearchLineMatch] | None:
    """Return grep line matches or ``None`` when grep should not be used."""

    grep_executable = shutil.which('grep')
    if grep_executable is None:
        return None
    if not candidates or max_matches <= 0:
        return []
    if not _grep_can_search(query, encoding=encoding):
        return None

    display_by_command_path = {candidate.command_path: candidate.display_path for candidate in candidates}
    matches: list[SearchLineMatch] = []
    for chunk in _chunk_candidates(candidates):
        args = [
            grep_executable,
            '-nH',
            '-I',
            '-i',
            '-E',
            '-Z',
            '-e',
            query,
            *[candidate.command_path for candidate in chunk],
        ]
        try:
            proc = subprocess.run(
                args,
                cwd=str(cwd) if cwd is not None else None,
                capture_output=True,
                text=False,
                check=False,
                timeout=_GREP_SUBPROCESS_TIMEOUT_SEC,
            )
        except OSError as exc:
            logger.debug('grep search launch failed err=%s', exc)
            return None
        except subprocess.TimeoutExpired as exc:
            logger.debug('grep search timed out err=%s', exc)
            return None
        if proc.returncode not in {0, 1}:
            stderr = proc.stderr.decode('utf-8', errors='replace').strip()
            logger.debug('grep search failed code=%s stderr=%s', proc.returncode, stderr)
            return None
        matches.extend(_parse_grep_matches(proc.stdout, display_by_command_path))
        if len(matches) >= max_matches:
            return matches[:max_matches]
    return matches


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


def _parse_grep_matches(stdout: bytes, display_by_command_path: dict[str, str]) -> list[SearchLineMatch]:
    matches: list[SearchLineMatch] = []
    cursor = 0
    total = len(stdout)
    while cursor < total:
        nul = stdout.find(b'\0', cursor)
        if nul == -1:
            break
        newline = stdout.find(b'\n', nul + 1)
        if newline == -1:
            newline = total
        command_path = stdout[cursor:nul].decode(errors='replace')
        payload = stdout[nul + 1 : newline]
        first_colon = payload.find(b':')
        if first_colon != -1:
            try:
                line_number = int(payload[:first_colon].decode('ascii', errors='strict'))
            except ValueError:
                line_number = -1
            if line_number > 0:
                matches.append(
                    SearchLineMatch(
                        display_path=display_by_command_path.get(command_path, command_path),
                        line_number=line_number,
                    )
                )
        cursor = newline + 1
    return matches
