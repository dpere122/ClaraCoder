"""Vetted text encodings and newline handling for workspace read/write tools.

Internal tool pipeline uses Unicode with ``\\n`` line endings. Encoding and newline
conversion happen at read (bytes → str) and write (str → bytes) boundaries.
"""

from __future__ import annotations

import codecs
from pathlib import Path
from typing import Literal

NewlineMode = Literal['lf', 'crlf', 'preserve']
DiskNewline = Literal['lf', 'crlf']

# Aliases → Python codec name (must pass validate_workspace_encoding after mapping).
_ENCODING_ALIASES: dict[str, str] = {
    'utf8': 'utf-8',
    'utf_8': 'utf-8',
    'utf-8-sig': 'utf-8-sig',
    'utf8-sig': 'utf-8-sig',
    'utf16': 'utf-16',
    'utf_16': 'utf-16',
    'utf-16le': 'utf-16-le',
    'utf16le': 'utf-16-le',
    'utf_16_le': 'utf-16-le',
    'utf-16be': 'utf-16-be',
    'utf16be': 'utf-16-be',
    'utf_16_be': 'utf-16-be',
    'latin1': 'latin-1',
    'iso-8859-1': 'latin-1',
    'iso8859-1': 'latin-1',
    'cp1252': 'cp1252',
    'windows-1252': 'cp1252',
    '1252': 'cp1252',
    'ascii': 'ascii',
    'mac_roman': 'mac-roman',
    'macintosh': 'mac-roman',
}

# Explicit allowlist (normalized names). All must be valid in Python codecs.
ALLOWED_ENCODINGS: frozenset[str] = frozenset(
    {
        'utf-8',
        'utf-8-sig',
        'utf-16',
        'utf-16-le',
        'utf-16-be',
        'latin-1',
        'cp1252',
        'ascii',
        'mac-roman',
    }
)

__all__ = [
    'ALLOWED_ENCODINGS',
    'NewlineMode',
    'DiskNewline',
    'decode_for_tools',
    'detect_newline_preference',
    'encode_for_disk',
    'normalize_encoding',
    'parse_newline_mode',
    'read_file_for_tools',
    'resolve_newline_for_write',
    'validate_workspace_encoding',
    'write_file_resolved',
    'write_file_to_disk',
]


def parse_newline_mode(name: str) -> NewlineMode:
    """Map tool/UI strings to a newline mode (unknown values default to ``lf``)."""
    t = name.strip().lower()
    if t in ('lf', 'unix'):
        return 'lf'
    if t in ('crlf', 'windows', 'dos'):
        return 'crlf'
    if t == 'preserve':
        return 'preserve'
    return 'lf'


def normalize_encoding(name: str) -> str:
    """Strip and map common aliases to a canonical codec name (not yet validated)."""
    key = name.strip().lower().replace('_', '-')
    mapped = _ENCODING_ALIASES.get(key, key)
    # utf-16-le vs utf-16le
    if mapped == 'utf-16le':
        return 'utf-16-le'
    if mapped == 'utf-16be':
        return 'utf-16-be'
    return mapped


def validate_workspace_encoding(encoding: str) -> str:
    """Return normalized encoding name or raise ValueError."""
    norm = normalize_encoding(encoding)
    if norm not in ALLOWED_ENCODINGS:
        allowed = ', '.join(sorted(ALLOWED_ENCODINGS))
        raise ValueError(f'Unsupported encoding {encoding!r}. Allowed: {allowed}')
    try:
        codecs.lookup(norm)
    except LookupError as exc:
        raise ValueError(f'Encoding {norm!r} is not available in this Python build.') from exc
    return norm


def decode_for_tools(raw: bytes, encoding: str, *, errors: str = 'replace') -> str:
    """Decode bytes and normalize all line endings to ``\\n`` for merges and line tools."""
    enc = validate_workspace_encoding(encoding)
    text = raw.decode(enc, errors=errors)
    return text.replace('\r\n', '\n').replace('\r', '\n')


def detect_newline_preference(raw: bytes) -> DiskNewline:
    """Guess on-disk newline style. Mixed files: CRLF wins if CRLF pairs are not fewer than lone LF runs."""
    if not raw:
        return 'lf'
    crlf = raw.count(b'\r\n')
    if crlf == 0:
        return 'lf'
    lone_lf = 0
    i = 0
    n = len(raw)
    while i < n:
        if i + 1 < n and raw[i] == 13 and raw[i + 1] == 10:
            i += 2
            continue
        if raw[i] == 10:
            lone_lf += 1
        i += 1
    return 'crlf' if crlf >= lone_lf else 'lf'


def resolve_newline_for_write(
    newline_mode: NewlineMode,
    *,
    path: Path | None,
    raw_existing: bytes | None = None,
) -> DiskNewline:
    """Resolve ``preserve`` using existing file bytes; new files default to LF."""
    if newline_mode == 'lf':
        return 'lf'
    if newline_mode == 'crlf':
        return 'crlf'
    if raw_existing is not None:
        return detect_newline_preference(raw_existing)
    if path is not None and path.is_file():
        try:
            return detect_newline_preference(path.read_bytes())
        except OSError:
            return 'lf'
    return 'lf'


def encode_for_disk(text: str, encoding: str, disk_newline: DiskNewline) -> bytes:
    """Convert internal ``\\n`` to on-disk newlines and encode (strict: unmappable chars raise)."""
    enc = validate_workspace_encoding(encoding)
    if disk_newline == 'crlf':
        body = text.replace('\n', '\r\n')
    else:
        body = text
    return body.encode(enc, errors='strict')


def read_file_for_tools(path: Path, encoding: str) -> str:
    """Read file as bytes and decode for the tool pipeline (newline-normalized to ``\\n``)."""
    raw = path.read_bytes()
    return decode_for_tools(raw, encoding)


def write_file_resolved(path: Path, text: str, encoding: str, disk_newline: DiskNewline) -> None:
    """Write using already-resolved LF/CRLF (e.g. after matching read_workspace_file + edit preamble)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(encode_for_disk(text, encoding, disk_newline))


def write_file_to_disk(
    path: Path,
    text: str,
    encoding: str,
    newline_mode: NewlineMode,
) -> None:
    """Write Unicode tool text to disk with vetted encoding and newline rules."""
    raw_existing: bytes | None = None
    if newline_mode == 'preserve' and path.is_file():
        try:
            raw_existing = path.read_bytes()
        except OSError:
            raw_existing = None
    disk_nl = resolve_newline_for_write(newline_mode, path=path, raw_existing=raw_existing)
    write_file_resolved(path, text, encoding, disk_nl)
