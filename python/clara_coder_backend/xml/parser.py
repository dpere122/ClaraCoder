"""Parse generic XML documents into a searchable path index."""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

from clara_coder_backend.session.state import current_session_id
from clara_coder_backend.xml.namespaces import SEARCH_SCOPES, SECTION_REF_PREFIX, WSDL_EXTENSION, XML_EXTENSIONS

_MAX_NODES = 5000
_GRAPH_CACHE: dict[tuple[str, str, int], 'XmlGraph'] = {}


def _normalize_relative_path(root: Path, relative_path: str) -> Path:
    cleaned = relative_path.strip().replace('\\', '/') or '.'
    candidate = (root / cleaned).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as exc:
        raise ValueError('Requested path is outside the active workspace.') from exc
    return candidate


def _local_name(tag: str) -> str:
    if tag.startswith('{'):
        closing = tag.find('}')
        if closing != -1:
            return tag[closing + 1 :]
    return tag


def _attr_text(element: ET.Element) -> str:
    if not element.attrib:
        return ''
    return ' '.join(f'{k}={v!r}' for k, v in sorted(element.attrib.items()))


def _text_preview(element: ET.Element, limit: int = 120) -> str:
    chunks: list[str] = []
    if element.text and element.text.strip():
        chunks.append(element.text.strip())
    for child in element:
        if child.tail and child.tail.strip():
            chunks.append(child.tail.strip())
        if len(' '.join(chunks)) >= limit:
            break
    text = ' '.join(chunks)
    if len(text) > limit:
        return text[: limit - 3] + '...'
    return text


@dataclass
class SectionRecord:
    ref: str
    path: str
    tag: str
    depth: int
    summary: str
    element: ET.Element
    search_blob: str


@dataclass
class XmlGraph:
    entry_rel_path: str
    entry_path: Path
    root_tag: str
    namespaces: dict[str, str]
    sections: dict[str, SectionRecord]
    node_count: int
    truncated: bool
    parse_error: str | None = None

    def section_refs(self) -> list[str]:
        return sorted(self.sections.keys())


def _parse_xml_file(path: Path) -> tuple[ET.Element | None, str | None]:
    try:
        tree = ET.parse(path)
    except ET.ParseError as exc:
        return None, f'XML parse error: {exc}'
    except OSError as exc:
        return None, f'could not read file: {exc}'
    return tree.getroot(), None


def _build_element_path(parent_path: str, tag: str, index: int) -> str:
    if index <= 1:
        return f'{parent_path}/{tag}'
    return f'{parent_path}/{tag}[{index}]'


def _index_element_tree(
    element: ET.Element,
    *,
    parent_path: str,
    depth: int,
    sections: dict[str, SectionRecord],
    counter: list[int],
    truncated_flag: list[bool],
) -> None:
    if counter[0] >= _MAX_NODES:
        truncated_flag[0] = True
        return

    tag = _local_name(element.tag)
    if parent_path == '':
        path = f'/{tag}'
    else:
        siblings = [c for c in element if _local_name(c.tag) == tag]
        # index among same-tag siblings under same parent - computed when walking from parent
        path = parent_path  # set by caller for this node

    attrs = _attr_text(element)
    text = _text_preview(element)
    summary_parts = [f'tag={tag}', f'depth={depth}']
    if attrs:
        summary_parts.append(f'attrs: {attrs}')
    if text:
        summary_parts.append(f'text: {text!r}')
    summary = '; '.join(summary_parts)

    ref = f'{SECTION_REF_PREFIX}{path}'
    blob = ' '.join([ref, path, tag, attrs, text, summary]).lower()
    sections[ref] = SectionRecord(
        ref=ref,
        path=path,
        tag=tag,
        depth=depth,
        summary=summary,
        element=element,
        search_blob=blob,
    )
    counter[0] += 1

    child_counts: dict[str, int] = {}
    for child in element:
        child_tag = _local_name(child.tag)
        child_counts[child_tag] = child_counts.get(child_tag, 0) + 1
        child_index = child_counts[child_tag]
        child_path = _build_element_path(path, child_tag, child_index)
        _index_element_tree(
            child,
            parent_path=child_path,
            depth=depth + 1,
            sections=sections,
            counter=counter,
            truncated_flag=truncated_flag,
        )


def build_xml_graph(workspace_root: Path, entry_path: Path, entry_rel_path: str) -> XmlGraph:
    session_id = current_session_id.get() or ''
    try:
        mtime_ns = entry_path.stat().st_mtime_ns
    except OSError:
        mtime_ns = 0
    cache_key = (session_id, entry_rel_path, mtime_ns)
    cached = _GRAPH_CACHE.get(cache_key)
    if cached is not None:
        return cached

    root, err = _parse_xml_file(entry_path)
    if root is None or err:
        graph = XmlGraph(
            entry_rel_path=entry_rel_path,
            entry_path=entry_path,
            root_tag='',
            namespaces={},
            sections={},
            node_count=0,
            truncated=False,
            parse_error=err or 'unknown parse failure',
        )
        _GRAPH_CACHE[cache_key] = graph
        return graph

    sections: dict[str, SectionRecord] = {}
    counter = [0]
    truncated_flag = [False]
    root_tag = _local_name(root.tag)
    _index_element_tree(
        root,
        parent_path=f'/{root_tag}',
        depth=0,
        sections=sections,
        counter=counter,
        truncated_flag=truncated_flag,
    )

    graph = XmlGraph(
        entry_rel_path=entry_rel_path,
        entry_path=entry_path,
        root_tag=root_tag,
        namespaces=dict(root.attrib),
        sections=sections,
        node_count=counter[0],
        truncated=truncated_flag[0],
        parse_error=None,
    )
    _GRAPH_CACHE[cache_key] = graph
    return graph


def resolve_xml_path(workspace_root: Path, relative_path: str) -> tuple[Path | None, str | None]:
    cleaned = relative_path.strip().replace('\\', '/')
    if not cleaned:
        return None, 'relative_path is required'
    suffix = Path(cleaned).suffix.lower()
    if suffix == WSDL_EXTENSION:
        return None, 'use wsdl_overview/search_wsdl/read_wsdl_section for `.wsdl` SOAP contracts'
    if suffix not in XML_EXTENSIONS:
        allowed = ', '.join(sorted(XML_EXTENSIONS))
        return None, f'path must use a supported XML extension ({allowed})'
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
    if not path.startswith('/'):
        return None
    return ref


def search_sections(
    graph: XmlGraph,
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
        if scope_norm == 'elements':
            haystacks = [section.tag, section.path]
        elif scope_norm == 'attributes':
            haystacks = [section.summary if 'attrs:' in section.summary else '']
        elif scope_norm == 'text':
            haystacks = [section.summary if 'text:' in section.summary else '']
        else:
            haystacks = [section.ref, section.path, section.tag, section.summary, section.search_blob]

        if any(pattern.search(h) for h in haystacks if h):
            matches.append(section)
            if len(matches) >= max_matches:
                break
    matches.sort(key=lambda s: s.path)
    return matches


def render_section_xml(section: SectionRecord) -> str:
    ET.indent(section.element, space='  ')
    return ET.tostring(section.element, encoding='unicode')


def clear_xml_cache_for_tests() -> None:
    _GRAPH_CACHE.clear()
