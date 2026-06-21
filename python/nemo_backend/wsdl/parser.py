"""Parse WSDL 1.1 documents into a searchable index graph."""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from nemo_backend.state import current_session_id

from nemo_backend.wsdl.namespaces import (
    SEARCH_SCOPES,
    SECTION_KINDS,
    SOAP_BINDING,
    SOAP_OPERATION,
    WSDL_IMPORT,
    WSDL_TYPES,
    iter_children,
    local_name,
)

_MAX_IMPORT_DEPTH = 3
_GRAPH_CACHE: dict[tuple[str, str, int, tuple[tuple[str, int], ...]], 'WsdlGraph'] = {}


def _normalize_relative_path(root: Path, relative_path: str) -> Path:
    """Resolve a user/tool-relative path under root; raise if it escapes the workspace."""
    cleaned = relative_path.strip().replace('\\', '/') or '.'
    candidate = (root / cleaned).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError('Requested path is outside the active workspace.') from exc
    return candidate



@dataclass(frozen=True)
class ImportRecord:
    kind: str
    location: str
    namespace: str
    resolved_path: str | None
    error: str | None = None


@dataclass
class SectionRecord:
    ref: str
    kind: str
    name: str
    file_path: str
    summary: str
    element: ET.Element
    search_blob: str


@dataclass
class WsdlDocument:
    path: Path
    rel_path: str
    root: ET.Element
    target_namespace: str
    document_kind: str  # 'wsdl' | 'xsd'
    imports: list[ImportRecord] = field(default_factory=list)
    parse_error: str | None = None


@dataclass
class WsdlGraph:
    entry_rel_path: str
    entry_path: Path
    documents: list[WsdlDocument]
    sections: dict[str, SectionRecord]
    unresolved_imports: list[ImportRecord]
    import_depth: int

    def section_refs(self) -> list[str]:
        return sorted(self.sections.keys())


def _attr(element: ET.Element, name: str, default: str = '') -> str:
    return (element.get(name) or default).strip()


def _resolve_import_path(
    workspace_root: Path,
    importing_file: Path,
    location: str,
) -> tuple[Path | None, str | None]:
    loc = location.strip().replace('\\', '/')
    if not loc or loc.startswith(('http://', 'https://', 'file:')):
        return None, 'external or empty location (workspace-relative paths only)'
    base_dir = importing_file.parent
    candidate = (base_dir / loc).resolve()
    try:
        candidate.relative_to(workspace_root.resolve())
    except ValueError:
        return None, 'import path escapes workspace'
    if not candidate.is_file():
        return None, 'import file not found on disk'
    return candidate, None


def _parse_xml_file(path: Path) -> tuple[ET.Element | None, str | None]:
    try:
        tree = ET.parse(path)
    except ET.ParseError as exc:
        return None, f'XML parse error: {exc}'
    except OSError as exc:
        return None, f'could not read file: {exc}'
    return tree.getroot(), None


def _collect_schema_imports_from_schema(
    workspace_root: Path,
    doc_path: Path,
    schema_el: ET.Element,
) -> list[ImportRecord]:
    records: list[ImportRecord] = []
    for imp in schema_el:
        tag = local_name(imp.tag)
        if tag not in ('import', 'include'):
            continue
        location = _attr(imp, 'schemaLocation')
        ns = _attr(imp, 'namespace') if tag == 'import' else _attr(schema_el, 'targetNamespace')
        resolved, err = _resolve_import_path(workspace_root, doc_path, location)
        records.append(
            ImportRecord(
                kind=f'xs:{tag}',
                location=location,
                namespace=ns,
                resolved_path=resolved.relative_to(workspace_root.resolve()).as_posix() if resolved else None,
                error=err,
            )
        )
    return records


def _collect_schema_imports(
    workspace_root: Path,
    doc_path: Path,
    types_el: ET.Element | None,
) -> list[ImportRecord]:
    if types_el is None:
        return []
    records: list[ImportRecord] = []
    for schema in types_el.iter():
        if local_name(schema.tag) != 'schema':
            continue
        records.extend(_collect_schema_imports_from_schema(workspace_root, doc_path, schema))
    return records


def _index_schema_types(schema_el: ET.Element, rel: str, sections: dict[str, SectionRecord]) -> None:
    for child in schema_el:
        tag = local_name(child.tag)
        name = _attr(child, 'name')
        if not name:
            continue
        if tag == 'element':
            _register_section(
                sections,
                ref=f'element:{name}',
                kind='element',
                name=name,
                file_path=rel,
                summary='xs:element',
                element=child,
            )
        elif tag == 'complexType':
            _register_section(
                sections,
                ref=f'type:{name}',
                kind='type',
                name=name,
                file_path=rel,
                summary='xs:complexType',
                element=child,
            )
        elif tag == 'simpleType':
            _register_section(
                sections,
                ref=f'type:{name}',
                kind='type',
                name=name,
                file_path=rel,
                summary='xs:simpleType',
                element=child,
            )


def _message_summary(message_el: ET.Element) -> str:
    parts: list[str] = []
    for part in iter_children(message_el, 'part'):
        pname = _attr(part, 'name')
        element = _attr(part, 'element')
        typ = _attr(part, 'type')
        if element:
            parts.append(f'{pname}→element {element}')
        elif typ:
            parts.append(f'{pname}→type {typ}')
        elif pname:
            parts.append(pname)
    return ', '.join(parts) if parts else '(no parts)'


def _operation_messages(op_el: ET.Element) -> str:
    bits: list[str] = []
    for child in op_el:
        tag = local_name(child.tag)
        if tag in ('input', 'output', 'fault'):
            msg = _attr(child, 'message')
            if msg:
                bits.append(f'{tag}={msg}')
    return '; '.join(bits)


def _binding_operation_summary(binding_name: str, op_el: ET.Element) -> str:
    op_name = _attr(op_el, 'name')
    soap_op = None
    for child in op_el:
        if child.tag == SOAP_OPERATION:
            soap_op = _attr(child, 'soapAction')
            break
    parts = [f'operation={op_name}']
    if soap_op:
        parts.append(f'soapAction={soap_op!r}')
    return ' '.join(parts)


def _soap_binding_style(binding_el: ET.Element) -> str:
    for child in binding_el:
        if child.tag == SOAP_BINDING:
            style = _attr(child, 'style') or 'document'
            transport = _attr(child, 'transport')
            bits = [f'style={style}']
            if transport:
                bits.append(f'transport={transport}')
            return ', '.join(bits)
    return ''


def _port_summary(port_el: ET.Element) -> str:
    binding = _attr(port_el, 'binding')
    location = ''
    for child in port_el:
        if local_name(child.tag) == 'address':
            location = _attr(child, 'location')
            break
    bits = [f'binding={binding}']
    if location:
        bits.append(f'location={location!r}')
    return ', '.join(bits)


def _element_to_pretty_xml(element: ET.Element) -> str:
    ET.indent(element, space='  ')
    return ET.tostring(element, encoding='unicode')


def _register_section(
    sections: dict[str, SectionRecord],
    *,
    ref: str,
    kind: str,
    name: str,
    file_path: str,
    summary: str,
    element: ET.Element,
    extra_search: str = '',
) -> None:
    if ref in sections:
        return
    blob_parts = [ref, kind, name, summary, extra_search, file_path]
    sections[ref] = SectionRecord(
        ref=ref,
        kind=kind,
        name=name,
        file_path=file_path,
        summary=summary,
        element=element,
        search_blob=' '.join(blob_parts).lower(),
    )


def _index_document(doc: WsdlDocument, sections: dict[str, SectionRecord]) -> None:
    if doc.document_kind == 'xsd':
        _index_schema_types(doc.root, doc.rel_path, sections)
        return

    root = doc.root
    rel = doc.rel_path

    for msg in iter_children(root, 'message'):
        name = _attr(msg, 'name')
        if not name:
            continue
        summary = _message_summary(msg)
        _register_section(
            sections,
            ref=f'message:{name}',
            kind='message',
            name=name,
            file_path=rel,
            summary=summary,
            element=msg,
        )

    for pt in iter_children(root, 'portType'):
        pt_name = _attr(pt, 'name')
        if not pt_name:
            continue
        op_names: list[str] = []
        for op in iter_children(pt, 'operation'):
            op_name = _attr(op, 'name')
            if not op_name:
                continue
            op_names.append(op_name)
            op_summary = _operation_messages(op)
            _register_section(
                sections,
                ref=f'operation:{pt_name}/{op_name}',
                kind='operation',
                name=op_name,
                file_path=rel,
                summary=f'portType={pt_name}; {op_summary}',
                element=op,
                extra_search=pt_name,
            )
        _register_section(
            sections,
            ref=f'portType:{pt_name}',
            kind='portType',
            name=pt_name,
            file_path=rel,
            summary=f'operations: {", ".join(op_names) if op_names else "(none)"}',
            element=pt,
        )

    for binding in iter_children(root, 'binding'):
        b_name = _attr(binding, 'name')
        if not b_name:
            continue
        b_type = _attr(binding, 'type')
        style_summary = _soap_binding_style(binding)
        binding_summary = f'type={b_type}'
        if style_summary:
            binding_summary += f'; {style_summary}'
        for op in iter_children(binding, 'operation'):
            op_name = _attr(op, 'name')
            if not op_name:
                continue
            op_summary = _binding_operation_summary(b_name, op)
            _register_section(
                sections,
                ref=f'binding_op:{b_name}/{op_name}',
                kind='binding_op',
                name=op_name,
                file_path=rel,
                summary=op_summary,
                element=op,
                extra_search=b_name,
            )
        _register_section(
            sections,
            ref=f'binding:{b_name}',
            kind='binding',
            name=b_name,
            file_path=rel,
            summary=binding_summary,
            element=binding,
        )

    for service in iter_children(root, 'service'):
        s_name = _attr(service, 'name')
        if not s_name:
            continue
        port_names: list[str] = []
        for port in iter_children(service, 'port'):
            p_name = _attr(port, 'name')
            if not p_name:
                continue
            port_names.append(p_name)
            _register_section(
                sections,
                ref=f'port:{s_name}/{p_name}',
                kind='port',
                name=p_name,
                file_path=rel,
                summary=_port_summary(port),
                element=port,
                extra_search=s_name,
            )
        _register_section(
            sections,
            ref=f'service:{s_name}',
            kind='service',
            name=s_name,
            file_path=rel,
            summary=f'ports: {", ".join(port_names) if port_names else "(none)"}',
            element=service,
        )

    types_el = root.find(WSDL_TYPES)
    if types_el is not None:
        for schema in types_el.iter():
            if local_name(schema.tag) != 'schema':
                continue
            _index_schema_types(schema, rel, sections)


def _load_document(
    workspace_root: Path,
    path: Path,
    rel_path: str,
) -> WsdlDocument:
    root, err = _parse_xml_file(path)
    if root is None or err:
        return WsdlDocument(
            path=path,
            rel_path=rel_path,
            root=ET.Element('invalid'),
            target_namespace='',
            document_kind='wsdl',
            parse_error=err or 'unknown parse failure',
        )
    root_local = local_name(root.tag)
    if root_local == 'schema':
        target_ns = _attr(root, 'targetNamespace')
        imports = _collect_schema_imports_from_schema(workspace_root, path, root)
        return WsdlDocument(
            path=path,
            rel_path=rel_path,
            root=root,
            target_namespace=target_ns,
            document_kind='xsd',
            imports=imports,
        )
    if root_local != 'definitions':
        return WsdlDocument(
            path=path,
            rel_path=rel_path,
            root=root,
            target_namespace='',
            document_kind='wsdl',
            parse_error='root element is not wsdl:definitions or xs:schema',
        )
    target_ns = _attr(root, 'targetNamespace')
    imports: list[ImportRecord] = []
    for imp in root.findall(WSDL_IMPORT):
        location = _attr(imp, 'location')
        ns = _attr(imp, 'namespace')
        resolved, imp_err = _resolve_import_path(workspace_root, path, location)
        imports.append(
            ImportRecord(
                kind='wsdl:import',
                location=location,
                namespace=ns,
                resolved_path=resolved.relative_to(workspace_root.resolve()).as_posix() if resolved else None,
                error=imp_err,
            )
        )
    types_el = root.find(WSDL_TYPES)
    imports.extend(_collect_schema_imports(workspace_root, path, types_el))
    return WsdlDocument(
        path=path,
        rel_path=rel_path,
        root=root,
        target_namespace=target_ns,
        document_kind='wsdl',
        imports=imports,
    )


def _graph_mtime_key(documents: list[WsdlDocument]) -> tuple[tuple[str, int], ...]:
    pairs: list[tuple[str, int]] = []
    for doc in documents:
        try:
            mtime = doc.path.stat().st_mtime_ns
        except OSError:
            mtime = 0
        pairs.append((doc.rel_path, mtime))
    return tuple(sorted(pairs))


def build_wsdl_graph(
    workspace_root: Path,
    entry_path: Path,
    entry_rel_path: str,
    *,
    import_depth: int = 1,
) -> WsdlGraph:
    """Parse entry WSDL and reachable imports up to ``import_depth``."""
    depth = max(0, min(int(import_depth), _MAX_IMPORT_DEPTH))
    session_id = current_session_id.get() or ''
    root_resolved = workspace_root.resolve()
    try:
        mtime_probe = entry_path.stat().st_mtime_ns
    except OSError:
        mtime_probe = 0
    cache_key = (session_id, entry_rel_path, depth, ((entry_rel_path, mtime_probe),))
    cached = _GRAPH_CACHE.get(cache_key)
    if cached is not None:
        return cached

    documents: list[WsdlDocument] = []
    unresolved: list[ImportRecord] = []
    seen_paths: set[str] = set()
    queue: list[tuple[Path, str, int]] = [(entry_path, entry_rel_path, 0)]

    while queue:
        path, rel, level = queue.pop(0)
        norm_rel = rel.replace('\\', '/')
        if norm_rel in seen_paths:
            continue
        seen_paths.add(norm_rel)
        doc = _load_document(root_resolved, path, norm_rel)
        documents.append(doc)
        if doc.parse_error or level >= depth:
            if level >= depth:
                for imp in doc.imports:
                    if imp.resolved_path and imp.resolved_path not in seen_paths:
                        unresolved.append(imp)
            continue
        for imp in doc.imports:
            if imp.resolved_path:
                if imp.resolved_path in seen_paths:
                    continue
                if level + 1 > depth:
                    unresolved.append(imp)
                    continue
                child_path = root_resolved / imp.resolved_path
                queue.append((child_path, imp.resolved_path, level + 1))
            elif imp.location:
                unresolved.append(imp)

    sections: dict[str, SectionRecord] = {}
    for doc in documents:
        if doc.parse_error:
            continue
        _index_document(doc, sections)

    graph = WsdlGraph(
        entry_rel_path=entry_rel_path,
        entry_path=entry_path,
        documents=documents,
        sections=sections,
        unresolved_imports=unresolved,
        import_depth=depth,
    )
    _GRAPH_CACHE[(session_id, entry_rel_path, depth, _graph_mtime_key(documents))] = graph
    return graph


def resolve_wsdl_path(workspace_root: Path, relative_path: str) -> tuple[Path | None, str | None]:
    """Resolve a workspace-relative WSDL path; return (path, error_message)."""
    cleaned = relative_path.strip().replace('\\', '/')
    if not cleaned:
        return None, 'relative_path is required'
    if not cleaned.lower().endswith('.wsdl'):
        return None, 'path must end with .wsdl (WSDL 1.1 reader)'
    try:
        target = _normalize_relative_path(workspace_root, cleaned)
    except ValueError as exc:
        return None, str(exc)
    if not target.exists():
        return None, f'`{cleaned}` is not on the workspace disk'
    if not target.is_file():
        return None, f'`{cleaned}` exists but is not a regular file'
    return target, None


def parse_section_ref(section_ref: str) -> tuple[str, str] | None:
    """Return (kind, identifier) or None if malformed."""
    ref = section_ref.strip()
    if ':' not in ref:
        return None
    kind, ident = ref.split(':', 1)
    if kind not in SECTION_KINDS or not ident.strip():
        return None
    return kind, ident.strip()


def search_sections(
    graph: WsdlGraph,
    query: str,
    *,
    scope: str = 'all',
    max_matches: int = 20,
) -> list[SectionRecord]:
    scope_norm = scope.strip().lower() or 'all'
    if scope_norm not in SEARCH_SCOPES:
        scope_norm = 'all'
    pattern = re.compile(re.escape(query.strip()), re.IGNORECASE) if query.strip() else None
    if pattern is None:
        return []

    kind_filter: set[str] | None = None
    if scope_norm == 'services':
        kind_filter = {'service', 'port'}
    elif scope_norm == 'operations':
        kind_filter = {'operation', 'portType', 'binding_op'}
    elif scope_norm == 'messages':
        kind_filter = {'message'}
    elif scope_norm == 'bindings':
        kind_filter = {'binding', 'binding_op'}
    elif scope_norm == 'types':
        kind_filter = {'type', 'element'}

    matches: list[SectionRecord] = []
    for section in graph.sections.values():
        if kind_filter is not None and section.kind not in kind_filter:
            continue
        if pattern.search(section.search_blob) or pattern.search(section.ref):
            matches.append(section)
            if len(matches) >= max_matches:
                break
    matches.sort(key=lambda s: s.ref)
    return matches


def render_section_xml(section: SectionRecord, *, expand_depth: int = 0) -> str:
    """Return pretty-printed XML for a section (optionally shallow child expansion)."""
    del expand_depth
    return _element_to_pretty_xml(section.element)


def clear_wsdl_cache_for_tests() -> None:
    """Test helper: drop cached parse graphs."""
    _GRAPH_CACHE.clear()
