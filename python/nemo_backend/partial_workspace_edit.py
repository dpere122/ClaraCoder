"""Merge partial edits into file text: line-range splice and snippet replace (exact, CRLF-normalize, fuzzy match)."""

from __future__ import annotations

import difflib
import logging
import re
from diff_match_patch import diff_match_patch

from nemo_backend.config import (
    SNIPPET_DMP_MATCH_THRESHOLD,
    SNIPPET_FUZZY_MIN_SIMILARITY,
    SNIPPET_FUZZY_TIE_DELTA,
)

__all__ = ['merge_partial_edit', 'line_range_edit_tool_feedback']

logger = logging.getLogger('nemo.partial_workspace_edit')

# Legacy read_workspace_file gutter "N: text"; current gutter uses U+2502 or ASCII "|" after padded line number.
_LINE_NUMBER_LEGACY_COLON = re.compile(r'^(\d+):\s?(.*)$')
_LINE_NUMBER_GUTTER_PIPE = re.compile(r'^\s*(\d+)\s*[│|]\s(.*)$')

# Fuzzy locate is unsafe for very short snippets (repeated tokens, wrong spans).
SNIPPET_FUZZY_MIN_LENGTH = 4


def _strip_one_read_tool_line(line: str) -> str | None:
    """Return file text from a single numbered read_workspace_file line, or None if not in that format."""
    m = _LINE_NUMBER_GUTTER_PIPE.match(line)
    if m:
        return m.group(2)
    m = _LINE_NUMBER_LEGACY_COLON.match(line)
    if m:
        return m.group(2)
    return None


def _strip_numbered_read_prefixes(snippet: str) -> str | None:
    """If every non-empty line looks like read_workspace_file numbered output, return stripped file text."""
    if not snippet:
        return None
    ends_nl = snippet.endswith('\n')
    # splitlines() avoids a spurious empty segment after a trailing ``\\n`` (unlike split('\\n')).
    lines = snippet.splitlines()
    out: list[str] = []
    for line in lines:
        if line == '':
            out.append('')
            continue
        stripped = _strip_one_read_tool_line(line)
        if stripped is None:
            return None
        out.append(stripped)
    result = '\n'.join(out)
    if ends_nl:
        result += '\n'
    return result


def _norm_crlf(s: str) -> str:
    return s.replace('\r\n', '\n').replace('\r', '\n')


def _norm_index_to_raw(raw: str, norm_index: int) -> int:
    """Map a character index in ``raw.replace('\\r\\n','\\n')`` to the corresponding index in ``raw``."""
    n = 0
    r = 0
    while n < norm_index and r < len(raw):
        if raw[r : r + 2] == '\r\n':
            r += 2
            n += 1
        else:
            r += 1
            n += 1
    return r


def _configure_dmp(dmp: diff_match_patch, text_len: int) -> None:
    # Stricter than library defaults to reduce wrong fuzzy matches on code-sized texts.
    dmp.Match_Threshold = SNIPPET_DMP_MATCH_THRESHOLD
    dmp.Match_Distance = max(100, min(text_len, 100_000))
    dmp.Patch_Margin = 4


def _similarity(a: str, b: str) -> float:
    if not a and not b:
        return 1.0
    return difflib.SequenceMatcher(None, a, b, autojunk=False).ratio()


def _exact_unique_replace(old_text: str, old_snippet: str, new_snippet: str) -> str | None:
    count = old_text.count(old_snippet)
    if count == 1:
        return old_text.replace(old_snippet, new_snippet, 1)
    return None


def _fuzzy_replace(dmp: diff_match_patch, old_text: str, old_snippet: str, new_snippet: str) -> str | None:
    if len(old_snippet) < SNIPPET_FUZZY_MIN_LENGTH:
        return None
    pat_len = len(old_snippet)
    locs: set[int] = {0}
    if old_text:
        locs.add(len(old_text) // 2)
        locs.add((len(old_text) * 3) // 4)
    first_line = old_snippet.split('\n', 1)[0]
    if len(first_line) >= 8:
        start = 0
        while True:
            j = old_text.find(first_line, start)
            if j < 0:
                break
            locs.add(max(0, j - 24))
            start = j + 1

    # (match_start, similarity) for candidates that pass length gate; tie-breaking rejects ambiguous patches.
    scored: list[tuple[int, float]] = []
    for loc in locs:
        if loc > len(old_text):
            continue
        found = dmp.match_main(old_text, old_snippet, loc)
        if found < 0:
            continue
        chunk = old_text[found : found + pat_len]
        if len(chunk) < max(1, pat_len // 2):
            continue
        ratio = _similarity(chunk, old_snippet)
        if ratio < SNIPPET_FUZZY_MIN_SIMILARITY:
            continue
        scored.append((found, ratio))

    if not scored:
        return None

    best_ratio = max(r for _, r in scored)
    close = [pair for pair in scored if pair[1] >= best_ratio - SNIPPET_FUZZY_TIE_DELTA]
    starts = {s for s, _ in close}
    if len(starts) > 1:
        logger.info(
            'snippet_merge fuzzy rejected: ambiguous (multiple locations within tie delta %.4f of best %.4f).',
            SNIPPET_FUZZY_TIE_DELTA,
            best_ratio,
        )
        return None

    best_loc = max(close, key=lambda x: (x[1], -x[0]))[0]
    end = best_loc + pat_len
    if end > len(old_text):
        end = len(old_text)
    return old_text[:best_loc] + new_snippet + old_text[end:]


def _crlf_relaxed_unique_replace(old_text: str, old_snippet: str, new_snippet: str) -> str | None:
    """Exact unique match after normalizing CRLF to LF in both strings; splice applies to original ``old_text``."""
    nt = _norm_crlf(old_text)
    ns = _norm_crlf(old_snippet)
    if ns == old_snippet and nt == old_text:
        return None
    count = nt.count(ns)
    if count != 1:
        return None
    ni = nt.find(ns)
    start_raw = _norm_index_to_raw(old_text, ni)
    end_raw = _norm_index_to_raw(old_text, ni + len(ns))
    return old_text[:start_raw] + new_snippet + old_text[end_raw:]


def _snippet_try_one(
    old_text: str,
    old_snippet: str,
    new_snippet: str,
    dmp: diff_match_patch,
) -> tuple[str | None, str | None]:
    """Return (merged, tag) on success, (None, 'ambiguous'), or (None, None) if no match."""
    c = old_text.count(old_snippet)
    if c > 1:
        return None, 'ambiguous'

    out = _exact_unique_replace(old_text, old_snippet, new_snippet)
    if out is not None:
        return out, 'exact_unique'

    out = _crlf_relaxed_unique_replace(old_text, old_snippet, new_snippet)
    if out is not None:
        return out, 'crlf_relaxed_exact'

    out = _fuzzy_replace(dmp, old_text, old_snippet, new_snippet)
    if out is not None:
        return out, 'fuzzy_match_main'

    return None, None


def _snippet_replace(old_text: str, old_snippet: str, new_snippet: str) -> tuple[str | None, str | None]:
    """Replace old_snippet with new_snippet: exact, CRLF-normalized exact, gated fuzzy; then strip ``N:`` read prefixes."""
    if not old_snippet:
        return None, 'old_snippet is empty.'

    dmp = diff_match_patch()
    _configure_dmp(dmp, len(old_text))

    merged, tag = _snippet_try_one(old_text, old_snippet, new_snippet, dmp)
    if tag == 'ambiguous':
        return (
            None,
            f'old_snippet appears {old_text.count(old_snippet)} times; include more surrounding lines so the match is unique, '
            'or use start_line and end_line with new_snippet.',
        )
    if merged is not None:
        logger.info('snippet_merge strategy=%s', tag)
        return merged, None

    stripped = _strip_numbered_read_prefixes(old_snippet)
    if stripped is not None and stripped != old_snippet:
        dmp2 = diff_match_patch()
        _configure_dmp(dmp2, len(old_text))
        merged, tag = _snippet_try_one(old_text, stripped, new_snippet, dmp2)
        if tag == 'ambiguous':
            return (
                None,
                f'old_snippet appears {old_text.count(stripped)} times after stripping line numbers; '
                'include more context or use start_line and end_line with new_snippet.',
            )
        if merged is not None:
            logger.info('snippet_merge strategy=%s phase=strip_line_numbers', tag)
            return merged, None

    count = old_text.count(old_snippet)
    if count > 1:
        return (
            None,
            f'old_snippet appears {count} times; include more surrounding lines so the match is unique, '
            'or use start_line and end_line with new_snippet.',
        )

    return None, 'old_snippet not found in file (tried exact match, CRLF-normalized exact, fuzzy locate, and numbered-line strip).'


def _line_range_replace(old_text: str, start_line: int, end_line: int, new_snippet: str) -> tuple[str | None, str | None]:
    """Replace 1-based inclusive line range [start_line, end_line] with new_snippet lines (same rules as read_workspace_file)."""
    if start_line < 1:
        return None, 'start_line must be >= 1.'
    if end_line < start_line:
        return None, 'end_line must be >= start_line.'
    lines = old_text.splitlines()
    n = len(lines)
    if start_line == n + 1 and end_line == start_line:
        if not old_text:
            return new_snippet, None
        append_lines = new_snippet.splitlines() if new_snippet else []
        new_lines = lines + append_lines
        new_text = '\n'.join(new_lines)
        if old_text.endswith('\n'):
            new_text += '\n'
        return new_text, None
    if start_line > n:
        return (
            None,
            f'start_line {start_line} is past end of file ({n} lines). '
            f'Use start_line=end_line={n + 1} to append after the last line.'
            + (' For an empty file, use start_line=end_line=1 to seed the file.' if n == 0 else ''),
        )
    if end_line > n:
        return (
            None,
            f'end_line {end_line} is past end of file ({n} lines). '
            f'Use start_line=end_line={n + 1} to append after the last line.'
            + (' For an empty file, use start_line=end_line=1 to seed the file.' if n == 0 else ''),
        )

    insert_lines = new_snippet.splitlines() if new_snippet else []
    new_lines = lines[: start_line - 1] + insert_lines + lines[end_line:]
    new_text = '\n'.join(new_lines)
    if old_text.endswith('\n'):
        new_text += '\n'
    return new_text, None


def _utf16_code_unit_len(text: str) -> int:
    """Length of *text* in UTF-16 code units (LSP ``Position.character``)."""
    return max(0, len(text.encode('utf-16-le')) // 2)


def _clip_block(label: str, body: str, max_chars: int) -> str:
    if len(body) <= max_chars:
        return f'{label}\n{body}' if body else f'{label}\n[empty]'
    return f'{label}\n{body[:max_chars]}\n... [truncated, {len(body) - max_chars} more chars] ...'


def line_range_edit_tool_feedback(
    baseline_text: str,
    start_line: int,
    end_line: int,
    new_snippet: str,
    *,
    max_excerpt_chars: int = 4000,
) -> str:
    """Human- and LSP-oriented summary of a successful line-range splice (same rules as ``_line_range_replace``).

    Appended to tool results so models retain the exact replaced span (lines, UTF-16 columns, and verbatim text).
    """
    if start_line < 1 or end_line < start_line:
        return ''

    lines = baseline_text.splitlines()
    n = len(lines)
    ns = new_snippet if new_snippet is not None else ''

    # Append-only after last line (or seed empty file via 1,1 on empty baseline).
    if start_line == n + 1 and end_line == start_line:
        ins = ns.splitlines() if ns else []
        if n == 0:
            return (
                '\n---\nLine-range edit detail:\n'
                '- Mode: empty baseline — replaced the virtual span at lines 1–1 (convention for an empty file).\n'
                f'- Inserted {len(ins)} new line(s) (split on ``\\n`` in ``new_snippet``).\n'
                f'- LSP insertion point (0-based line, UTF-16 character): (0, 0) — zero-width; new text follows.\n'
                f'{_clip_block("Inserted text (verbatim new_snippet):", ns, max_excerpt_chars)}'
            )
        last = lines[-1]
        line0 = n - 1
        ch0 = _utf16_code_unit_len(last)
        return (
            '\n---\nLine-range edit detail:\n'
            f'- Mode: append after last baseline line (baseline had {n} line(s)).\n'
            f'- Parameters: start_line=end_line={start_line} (1-based).\n'
            f'- LSP insertion point after last character removed: '
            f'({line0}, {ch0}) — 0-based line/UTF-16 character; zero-width range.\n'
            f'- Inserted {len(ins)} new line(s).\n'
            f'{_clip_block("Inserted text (verbatim new_snippet):", ns, max_excerpt_chars)}'
        )

    if start_line > n or end_line > n:
        return ''

    removed = lines[start_line - 1 : end_line]
    ins_lines = ns.splitlines() if ns else []
    last_removed = removed[-1] if removed else ''

    start_l0 = start_line - 1
    start_ch0 = 0
    if end_line < n:
        end_l0 = end_line
        end_ch0 = 0
    else:
        end_l0 = end_line - 1
        end_ch0 = _utf16_code_unit_len(last_removed)

    start_cp_col1 = 1
    if end_line < n:
        end_ex_line1 = end_line + 1
        end_ex_col1 = 1
    else:
        end_ex_line1 = end_line
        end_ex_col1 = len(last_removed) + 1

    removed_body = '\n'.join(removed)
    ins_body = ns

    return (
        '\n---\nLine-range edit detail (same line numbering as ``read_workspace_file``, 1-based):\n'
        f'- Replaced inclusive baseline lines: {start_line}–{end_line} ({len(removed)} line(s)).\n'
        f'- Start of removed span — 1-based (line, column) first replaced character: ({start_line}, {start_cp_col1}). '
        'Column counts Unicode scalar values (code points), not the read-tool gutter.\n'
        f'- End of removed span — 1-based exclusive (line, column) first character after the removed span: '
        f'({end_ex_line1}, {end_ex_col1}).\n'
        f'- LSP-style range — 0-based line/UTF-16 ``character``, end exclusive: '
        f'{{"start": {{"line": {start_l0}, "character": {start_ch0}}}, '
        f'"end": {{"line": {end_l0}, "character": {end_ch0}}}}}\n'
        f'- Inserted {len(ins_lines)} new line(s) from ``new_snippet``.\n'
        f'{_clip_block("Removed baseline text (verbatim lines merged out):", removed_body, max_excerpt_chars)}\n'
        f'{_clip_block("Inserted text (verbatim new_snippet):", ins_body, max_excerpt_chars)}'
    )


def merge_partial_edit(
    old_text: str,
    *,
    new_content: str,
    old_snippet: str,
    new_snippet: str,
    start_line: int,
    end_line: int,
) -> tuple[str | None, str | None]:
    """
    Produce merged file text. Exactly one mode applies (priority order):

    1. Line range: start_line >= 1 and end_line >= start_line — replace those lines with new_snippet (may be empty to delete lines).
    2. Full file: non-empty new_content — entire file becomes new_content.
    3. Snippet: non-empty old_snippet — replace that span with new_snippet (may be empty).

    Line range beats full file and snippet; full file beats snippet when both strings are set.
    """
    osnip = old_snippet or ''
    nc = new_content or ''
    ns = new_snippet if new_snippet is not None else ''

    if start_line > 0 and end_line >= start_line:
        return _line_range_replace(old_text, start_line, end_line, ns)

    if nc != '':
        return nc, None

    if osnip != '':
        return _snippet_replace(old_text, osnip, ns)

    return (
        None,
        'Provide one of: (1) new_content with the full file, (2) old_snippet and new_snippet for a search/replace block, '
        'or (3) start_line, end_line, and new_snippet to replace a line range (1-based, inclusive).',
    )
