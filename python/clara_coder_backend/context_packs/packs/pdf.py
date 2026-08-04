"""PDF reading playbook (activated on first ``read_workspace_file`` of a ``.pdf``)."""

from __future__ import annotations

from textwrap import dedent

from clara_coder_backend.context_packs.registry import ContextPack, register_pack

register_pack(
    ContextPack(
        id='pdf',
        summary=(
            'PDF page reads via `read_workspace_file` (auto on `.pdf`, or `activate_context`)'
        ),
        body=dedent(
            """
            PDF workflow:
            - Use `read_workspace_file` on `.pdf` paths. `start_line` / `end_line` are **1-based inclusive page numbers**, not text lines.
            - `include_line_numbers` and `encoding` are ignored for PDFs.
            - Output is capped by Settings → Tools `maxFileReadLines` (page window). Widen the page range or call again for more pages; the header reports total page count.
            - Prefer small page windows over dumping an entire document.
            - PDFs may also appear in the semantic index (`retrieve_workspace_semantic`); verify hits by reading the cited pages.
            """
        ).strip(),
        tool_names=('read_workspace_file',),
        path_suffixes=('.pdf',),
    )
)
