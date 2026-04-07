"""Build a JSON-serializable side-by-side diff payload using diff-match-patch (line mode)."""

from __future__ import annotations

import hashlib
import logging
from pathlib import PurePosixPath

from diff_match_patch import diff_match_patch

from nemo_backend.config import DIFF_VERIFY_PATCH_MAX_BYTES, MAX_DIFF_INPUT_BYTES, MAX_DIFF_OUTPUT_ROWS

logger = logging.getLogger('nemo.diff_payload')

# diff_main / diff_charsToLines use integer op codes (Google diff-match-patch).
DIFF_DELETE = -1
DIFF_INSERT = 1
DIFF_EQUAL = 0

__all__ = ['build_file_diff_payload', 'language_hint_for_path']


def language_hint_for_path(relative_path: str) -> str:
    ext = PurePosixPath(relative_path.replace('\\', '/')).suffix.lower()
    return {
        '.ts': 'typescript',
        '.tsx': 'tsx',
        '.js': 'javascript',
        '.jsx': 'javascript',
        '.mjs': 'javascript',
        '.cjs': 'javascript',
        '.json': 'json',
        '.html': 'xml',
        '.htm': 'xml',
        '.xml': 'xml',
        '.css': 'css',
        '.scss': 'scss',
        '.less': 'less',
        '.md': 'markdown',
        '.py': 'python',
        '.rs': 'rust',
        '.go': 'go',
        '.java': 'java',
        '.kt': 'kotlin',
        '.cs': 'csharp',
        '.cpp': 'cpp',
        '.cc': 'cpp',
        '.cxx': 'cpp',
        '.h': 'cpp',
        '.hpp': 'cpp',
        '.c': 'c',
        '.rb': 'ruby',
        '.php': 'php',
        '.sql': 'sql',
        '.yaml': 'yaml',
        '.yml': 'yaml',
        '.toml': 'ini',
        '.ini': 'ini',
        '.sh': 'bash',
        '.bash': 'bash',
        '.ps1': 'powershell',
        '.psm1': 'powershell',
    }.get(ext, 'plaintext')


def _split_lines(text: str) -> list[str]:
    if not text:
        return []
    return text.splitlines()


def _verify_patch(old_text: str, new_text: str) -> bool:
    dmp = diff_match_patch()
    patches = dmp.patch_make(old_text, new_text)
    applied, results = dmp.patch_apply(patches, old_text)
    if not all(results):
        return False
    return applied == new_text


def _diffs_to_rows(diffs: list[tuple[int, str]]) -> list[dict]:
    rows: list[dict] = []
    left_no = 1
    right_no = 1
    hunk_idx = -1
    in_hunk = False

    def start_hunk() -> None:
        nonlocal hunk_idx, in_hunk
        if not in_hunk:
            hunk_idx += 1
            in_hunk = True

    def end_hunk() -> None:
        nonlocal in_hunk
        in_hunk = False

    i = 0
    while i < len(diffs):
        op, chunk = diffs[i]
        if op == DIFF_EQUAL:
            end_hunk()
            for line in _split_lines(chunk):
                rows.append(
                    {
                        'kind': 'equal',
                        'leftLine': left_no,
                        'rightLine': right_no,
                        'leftText': line,
                        'rightText': line,
                        'hunkIndex': max(hunk_idx, 0),
                    }
                )
                left_no += 1
                right_no += 1
            i += 1
            continue

        start_hunk()
        if op == DIFF_DELETE and i + 1 < len(diffs) and diffs[i + 1][0] == DIFF_INSERT:
            del_lines = _split_lines(chunk)
            ins_lines = _split_lines(diffs[i + 1][1])
            n = max(len(del_lines), len(ins_lines))
            for k in range(n):
                dl = del_lines[k] if k < len(del_lines) else ''
                ir = ins_lines[k] if k < len(ins_lines) else ''
                if k < len(del_lines) and k < len(ins_lines):
                    kind = 'replace'
                elif k < len(del_lines):
                    kind = 'remove'
                else:
                    kind = 'add'
                rows.append(
                    {
                        'kind': kind,
                        'leftLine': left_no if k < len(del_lines) else None,
                        'rightLine': right_no if k < len(ins_lines) else None,
                        'leftText': dl,
                        'rightText': ir,
                        'hunkIndex': hunk_idx,
                    }
                )
                if k < len(del_lines):
                    left_no += 1
                if k < len(ins_lines):
                    right_no += 1
            i += 2
            continue

        if op == DIFF_DELETE:
            for line in _split_lines(chunk):
                rows.append(
                    {
                        'kind': 'remove',
                        'leftLine': left_no,
                        'rightLine': None,
                        'leftText': line,
                        'rightText': '',
                        'hunkIndex': hunk_idx,
                    }
                )
                left_no += 1
            i += 1
            continue

        if op == DIFF_INSERT:
            for line in _split_lines(chunk):
                rows.append(
                    {
                        'kind': 'add',
                        'leftLine': None,
                        'rightLine': right_no,
                        'leftText': '',
                        'rightText': line,
                        'hunkIndex': hunk_idx,
                    }
                )
                right_no += 1
            i += 1
            continue

        i += 1

    return rows


def build_file_diff_payload(
    relative_path: str,
    old_text: str,
    new_text: str,
    *,
    disk_encoding: str = 'utf-8',
    disk_newline: str = 'lf',
) -> tuple[dict | None, str | None]:
    """Return (payload, error_message). On success error_message is None.

    ``disk_encoding`` / ``disk_newline`` are applied when the Electron shell writes
    ``fullNewContent`` to disk (resolved LF vs CRLF; no ``preserve`` here).
    """
    if disk_newline not in ('lf', 'crlf'):
        return None, f'Invalid disk_newline {disk_newline!r} (expected lf or crlf).'

    if '\x00' in old_text or '\x00' in new_text:
        return None, 'Refusing diff: content appears binary (NUL bytes).'

    o_bytes = len(old_text.encode('utf-8', errors='replace'))
    n_bytes = len(new_text.encode('utf-8', errors='replace'))
    if o_bytes > MAX_DIFF_INPUT_BYTES or n_bytes > MAX_DIFF_INPUT_BYTES:
        return None, (
            f'Refusing diff: file too large (limit {MAX_DIFF_INPUT_BYTES} bytes per side '
            f'for old/new content).'
        )

    skip_verify = o_bytes > DIFF_VERIFY_PATCH_MAX_BYTES or n_bytes > DIFF_VERIFY_PATCH_MAX_BYTES
    if skip_verify:
        logger.info(
            'diff_payload: skipping patch round-trip verify (size over limit %s bytes).',
            DIFF_VERIFY_PATCH_MAX_BYTES,
        )
    elif not _verify_patch(old_text, new_text):
        logger.warning(
            'diff_payload: patch round-trip verify failed; building line diff anyway (merge path already produced new_text).'
        )

    dmp = diff_match_patch()
    chars1, chars2, line_array = dmp.diff_linesToChars(old_text, new_text)
    diffs = dmp.diff_main(chars1, chars2, False)
    # Semantic cleanup improves human-readable boundaries; efficiency pass shortens the diff (fewer spurious hunks).
    dmp.diff_cleanupSemantic(diffs)
    dmp.diff_cleanupEfficiency(diffs)
    dmp.diff_charsToLines(diffs, line_array)

    rows = _diffs_to_rows(diffs)
    truncated = len(rows) > MAX_DIFF_OUTPUT_ROWS
    if truncated:
        rows = rows[:MAX_DIFF_OUTPUT_ROWS]

    base_sha256 = hashlib.sha256(old_text.encode('utf-8', errors='replace')).hexdigest()

    payload: dict = {
        'version': 1,
        'relativePath': relative_path.replace('\\', '/'),
        'language': language_hint_for_path(relative_path),
        'rows': rows,
        'fullOriginalContent': old_text,
        'fullNewContent': new_text,
        'truncated': truncated,
        'baseSha256': base_sha256,
        'diskEncoding': disk_encoding,
        'diskNewline': disk_newline,
    }
    return payload, None
