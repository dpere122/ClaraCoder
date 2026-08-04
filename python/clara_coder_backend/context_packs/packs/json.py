"""JSON search-and-zoom playbook."""

from __future__ import annotations

from textwrap import dedent

from clara_coder_backend.context_packs.registry import ContextPack, register_pack

register_pack(
    ContextPack(
        id='json',
        summary=(
            'JSON/JSONC search-and-zoom playbook (auto on `json_*`, or `activate_context`)'
        ),
        body=dedent(
            """
            JSON structured-read workflow:
            - Prefer `json_overview` → `search_json` → `read_json_section` for `.json` / `.jsonc`.
            - Start with `json_overview` for the key/path index and `section_ref` values (e.g. `path:config.host`).
            - Use `search_json` for key paths, key names, or scalar values; then zoom with `read_json_section`.
            - Avoid whole-file `read_workspace_file` for large configs; use section zoom instead.
            - Output is size-capped; keep queries narrow when indexing huge files.
            """
        ).strip(),
        tool_prefixes=('json_',),
    )
)
