"""Parse JSON documents into a searchable path index."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from clara_coder_backend.state import current_session_id
from clara_coder_backend.json.namespaces import JSON_EXTENSIONS, SEARCH_SCOPES, SECTION_REF_PREFIX

_MAX_PATHS = 5000
_GRAPH_CACHE: dict[tuple[str, str, int], 'JsonGraph'] = {}


def _normalize_relative_path(root: Path, relative_path: str) -> Path:
    cleaned = relative_path.strip().replace('\\', '/') or '.'
    candidate = (root / cleaned).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as exc:
        raise ValueError('Requested path is outside the active workspace.') from exc
    return candidate


def _strip_jsonc_comments(text: str) -> str:
    """Remove // and /* */ comments for `.jsonc` (best-effort, not a full JSONC parser)."""
    out: list[str] = []
    i = 0
    n = len(text)
    in_string = False
    escape = False
    while i < n:
        ch = text[i]
        if in_string:
            out.append(ch)
            if escape:
                escape = False
            elif ch == '\\':
                escape = True
            elif ch == '"':
                in_string = False
            i += 1
            continue
        if ch == '"':
            in_string = True
            out.append(ch)
            i += 1
            continue
        if ch == '/' and i + 1 < n:
            nxt = text[i + 1]
            if nxt == '/':
                i += 2
                while i < n and text[i] not in '\r\n':
                    i += 1
                continue
            if nxt == '*':
                i += 2
                while i + 1 < n and text[i : i + 2] != '*/':
                    i += 1
                i = min(i + 2, n)
                continue
        out.append(ch)
        i += 1
    return ''.join(out)


def _read_json_text(path: Path) -> tuple[str | None, str | None]:
    try:
        raw = path.read_text(encoding='utf-8')
    except OSError as exc:
        return None, f'could not read file: {exc}'
    if path.suffix.lower() == '.jsonc':
        raw = _strip_jsonc_comments(raw)
    return raw, None


def _value_preview(value: Any, limit: int = 120) -> str:
    if isinstance(value, dict):
        return f'object({len(value)} keys)'
    if isinstance(value, list):
        return f'array({len(value)} items)'
    if isinstance(value, str):
        text = value.replace('\n', '\\n')
        if len(text) > limit:
            return f'{text[: limit - 3]!r}...'
        return repr(text)
    return repr(value)


def _path_ref(path: str) -> str:
    return f'{SECTION_REF_PREFIX}{path}'


def _join_path(base: str, key: str) -> str:
    if not base:
        return key
    if key.startswith('['):
        return f'{base}{key}'
    return f'{base}.{key}'


@dataclass
class SectionRecord:
    ref: str
    path: str
    kind: str
    summary: str
    value: Any
    search_blob: str


@dataclass
class JsonGraph:
    entry_rel_path: str
    entry_path: Path
    root_kind: str
    sections: dict[str, SectionRecord]
    path_count: int
    truncated: bool
    parse_error: str | None = None

    def section_refs(self) -> list[str]:
        return sorted(self.sections.keys())


def _index_value(
    value: Any,
    path: str,
    sections: dict[str, SectionRecord],
    counter: list[int],
    truncated_flag: list[bool],
) -> None:
    if counter[0] >= _MAX_PATHS:
        truncated_flag[0] = True
        return

    if isinstance(value, dict):
        kind = 'object'
        summary = f'object with {len(value)} key(s)'
    elif isinstance(value, list):
        kind = 'array'
        summary = f'array with {len(value)} item(s)'
    else:
        kind = type(value).__name__
        summary = _value_preview(value)

    ref = _path_ref(path or '$')
    blob = ' '.join([ref, path, kind, summary, str(value) if isinstance(value, (str, int, float, bool)) else '']).lower()
    sections[ref] = SectionRecord(
        ref=ref,
        path=path or '$',
        kind=kind,
        summary=summary,
        value=value,
        search_blob=blob,
    )
    counter[0] += 1

    if isinstance(value, dict):
        for key, child in value.items():
            child_path = _join_path(path, str(key))
            _index_value(child, child_path, sections, counter, truncated_flag)
            if truncated_flag[0]:
                return
    elif isinstance(value, list):
        for index, child in enumerate(value):
            child_path = _join_path(path, f'[{index}]')
            _index_value(child, child_path, sections, counter, truncated_flag)
            if truncated_flag[0]:
                return


def build_json_graph(workspace_root: Path, entry_path: Path, entry_rel_path: str) -> JsonGraph:
    session_id = current_session_id.get() or ''
    try:
        mtime_ns = entry_path.stat().st_mtime_ns
    except OSError:
        mtime_ns = 0
    cache_key = (session_id, entry_rel_path, mtime_ns)
    cached = _GRAPH_CACHE.get(cache_key)
    if cached is not None:
        return cached

    raw, read_err = _read_json_text(entry_path)
    if raw is None or read_err:
        graph = JsonGraph(
            entry_rel_path=entry_rel_path,
            entry_path=entry_path,
            root_kind='',
            sections={},
            path_count=0,
            truncated=False,
            parse_error=read_err or 'unknown read failure',
        )
        _GRAPH_CACHE[cache_key] = graph
        return graph

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        graph = JsonGraph(
            entry_rel_path=entry_rel_path,
            entry_path=entry_path,
            root_kind='',
            sections={},
            path_count=0,
            truncated=False,
            parse_error=f'JSON parse error: {exc}',
        )
        _GRAPH_CACHE[cache_key] = graph
        return graph

    sections: dict[str, SectionRecord] = {}
    counter = [0]
    truncated_flag = [False]
    _index_value(data, '', sections, counter, truncated_flag)

    if isinstance(data, dict):
        root_kind = 'object'
    elif isinstance(data, list):
        root_kind = 'array'
    else:
        root_kind = type(data).__name__

    graph = JsonGraph(
        entry_rel_path=entry_rel_path,
        entry_path=entry_path,
        root_kind=root_kind,
        sections=sections,
        path_count=counter[0],
        truncated=truncated_flag[0],
        parse_error=None,
    )
    _GRAPH_CACHE[cache_key] = graph
    return graph


def resolve_json_path(workspace_root: Path, relative_path: str) -> tuple[Path | None, str | None]:
    cleaned = relative_path.strip().replace('\\', '/')
    if not cleaned:
        return None, 'relative_path is required'
    suffix = Path(cleaned).suffix.lower()
    if suffix not in JSON_EXTENSIONS:
        allowed = ', '.join(sorted(JSON_EXTENSIONS))
        return None, f'path must use a supported JSON extension ({allowed})'
    try:
        target = _normalize_relative_path(workspace_root.resolve(), cleaned)
    except ValueError as exc:
        return None, str(exc)
    if not target.exists():
        return None, f'`{cleaned}` is not on the workspace disk'
    if not target.is_file():
        return None, f'`{cleaned}` exists but is not a regular file'
    return target, None


def parse_section_ref(section_ref: str) -> str | None:
    ref = section_ref.strip()
    if not ref.startswith(SECTION_REF_PREFIX):
        return None
    path = ref[len(SECTION_REF_PREFIX) :].strip()
    if not path:
        return None
    return ref


def search_sections(
    graph: JsonGraph,
    query: str,
    *,
    scope: str = 'all',
    max_matches: int = 20,
) -> list[SectionRecord]:
    scope_norm = (scope or 'all').strip().lower()
    if scope_norm not in SEARCH_SCOPES:
        scope_norm = 'all'
    q = query.strip()
    if not q:
        return []
    pattern = re.compile(re.escape(q), re.IGNORECASE)

    matches: list[SectionRecord] = []
    for section in graph.sections.values():
        if scope_norm == 'keys':
            key_part = section.path.rsplit('.', 1)[-1] if section.path else '$'
            haystacks = [key_part, section.path]
        elif scope_norm == 'values':
            haystacks = [section.summary, str(section.value) if isinstance(section.value, (str, int, float, bool)) else '']
        else:
            haystacks = [section.ref, section.path, section.summary, section.search_blob]

        if any(pattern.search(h) for h in haystacks if h):
            matches.append(section)
            if len(matches) >= max_matches:
                break
    matches.sort(key=lambda s: s.path)
    return matches


def render_section_json(section: SectionRecord, *, indent: int = 2) -> str:
    return json.dumps(section.value, indent=indent, ensure_ascii=False)


def clear_json_cache_for_tests() -> None:
    _GRAPH_CACHE.clear()
