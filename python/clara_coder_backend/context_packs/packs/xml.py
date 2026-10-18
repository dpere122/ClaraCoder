"""XML search-and-zoom playbook."""

from __future__ import annotations

from textwrap import dedent

from clara_coder_backend.context_packs.registry import ContextPack, register_pack
from clara_coder_backend.xml.namespaces import XML_EXTENSIONS

register_pack(
    ContextPack(
        id='xml',
        summary=(
            'XML/XSD/XSL search-and-zoom playbook (auto on `structured_*` for XML-family files, or `activate_context`)'
        ),
        body=dedent(
            """
            XML structured-read workflow:
            - Prefer `structured_overview` → `search_structured` → `read_structured_section` for `.xml`, `.xsd`, `.xsl`, `.svg`, and similar markup.
            - `.wsdl` files get the WSDL reader instead (same tools; see the `wsdl` pack).
            - Start with `structured_overview` for structure and `section_ref` values; search for element/attribute names; zoom with `read_structured_section`.
            - Avoid whole-file `read_workspace_file` unless debugging raw markup or the file is tiny.
            - Output is size-capped; stay on section refs for large documents.
            """
        ).strip(),
        tool_names=('structured_overview', 'search_structured', 'read_structured_section'),
        path_suffixes=tuple(sorted(XML_EXTENSIONS)),
    )
)
