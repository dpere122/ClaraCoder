"""WSDL search-and-zoom playbook."""

from __future__ import annotations

from textwrap import dedent

from clara_coder_backend.context_packs.registry import ContextPack, register_pack

register_pack(
    ContextPack(
        id='wsdl',
        summary=(
            'SOAP/WSDL search-and-zoom playbook (auto on `wsdl_*`, or `activate_context`)'
        ),
        body=dedent(
            """
            WSDL / SOAP contract workflow:
            - Prefer `wsdl_overview` → `search_wsdl` → `read_wsdl_section`. Avoid reading whole WSDL/XSD with `read_workspace_file` unless debugging raw XML.
            - Start with `wsdl_overview(relative_path)` to get an index and `section_ref` values.
            - Use `search_wsdl` when you know part of an operation, message, binding, or type name.
            - Zoom with `read_wsdl_section(relative_path, section_ref)`. Refs look like `operation:PortType/GetCustomer`, `message:Req`, `type:CustomerType`.
            - `import_depth` is 0–3 (default 1) and follows wsdl/xs imports; raise carefully if the target lives in an imported schema.
            - Output is size-capped; stay on section refs instead of whole-file dumps.
            """
        ).strip(),
        tool_prefixes=('wsdl_',),
    )
)
