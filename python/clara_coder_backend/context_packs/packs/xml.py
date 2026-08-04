"""XML search-and-zoom playbook."""

from __future__ import annotations

from textwrap import dedent

from clara_coder_backend.context_packs.registry import ContextPack, register_pack

register_pack(
    ContextPack(
        id='xml',
        summary=(
            'XML/XSD/XSL search-and-zoom playbook (auto on `xml_*`, or `activate_context`)'
        ),
        body=dedent(
            """
            XML structured-read workflow:
            - Prefer `xml_overview` → `search_xml` → `read_xml_section` for `.xml`, `.xsd`, `.xsl`, `.svg`, and similar markup.
            - Do **not** use these tools for `.wsdl` — use the `wsdl` context pack / `wsdl_*` tools instead.
            - Start with `xml_overview` for structure and `section_ref` values; search for element/attribute names; zoom with `read_xml_section`.
            - Avoid whole-file `read_workspace_file` unless debugging raw markup or the file is tiny.
            - Output is size-capped; stay on section refs for large documents.
            """
        ).strip(),
        tool_prefixes=('xml_',),
    )
)
