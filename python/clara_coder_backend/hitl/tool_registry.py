"""Central registry for LangChain tools and human-in-the-loop (HITL) policy.

**Outer agent** — workspace reads/search (including ``retrieve_workspace_semantic`` and ``retrieve_workspace_checkpoint_semantic`` for on-disk semantic recall); ``copy_workspace_files``; ``delete_workspace_entry`` and
``batch_delete_workspace_entries`` (any path, with HITL when auto-apply is off); staged create/update tools
(``stage_create_file``, ``stage_workspace_file_overwrite``, ``stage_line_range_edit``, optional ``stage_snippet_edit``);
Python LSP staging mutators (``lsp_create_python_file``, ``lsp_update_python_file``, ``lsp_delete_python_file``),
TypeScript/JavaScript LSP staging mutators (``lsp_create_typescript_file``, etc.), GDScript LSP staging mutators
(``lsp_create_gdscript_file``, etc.), and Java LSP staging mutators (``lsp_create_java_file``, etc.);
plus staging review/transfer tools.

When Editor and Auto-apply are both on, staging tools are replaced by direct workspace mutators
(``apply_workspace_full_file``, ``replace_workspace_line_range``, optional ``replace_workspace_snippet``).

**HITL** — diff pause for edit tools; delete/copy/accept-command pauses when auto-apply is off; **staged→workspace**
``transfer_staged_file_to_workspace`` builds a diff and defers the disk write until
the user confirms in chat (or returns for re-review) unless auto-apply is on.
Workspace **execute** tools (staging overlay commands and generic ``run_command`` background jobs with
``wait_for_command`` / ``kill_background_command`` / ``list_background_commands``) use the same
accept-command pause when auto-apply is off (see :mod:`clara_coder_backend.hitl.deferred_tool_hitl`).
``run_command`` with ``elevate`` / a leading ``sudo`` still stages the composer Admin grant card
even when auto-apply is on, until the user allows administrator access for that conversation.
"""

from __future__ import annotations

from typing import Any

from clara_coder_backend.tools.copy import COPY_WORKSPACE_FILES_NAME, copy_workspace_files
from clara_coder_backend.tools.delete import (
    BATCH_DELETE_WORKSPACE_ENTRIES_NAME,
    DELETE_WORKSPACE_ENTRY_NAME,
    batch_delete_workspace_entries,
    delete_workspace_entry,
)
from clara_coder_backend.tools.review_tools import (
    FORMAT_STAGING_FILE_BLACK_NAME,
    FORMAT_STAGING_FILE_PRETTIER_NAME,
    FORMAT_WORKSPACE_FILE_BLACK_NAME,
    FORMAT_WORKSPACE_FILE_PRETTIER_NAME,
    TRANSFER_STAGED_FILE_TO_WORKSPACE_NAME,
)
from clara_coder_backend.tools.lsp_tools import (
    LSP_CREATE_GDSCRIPT_FILE_NAME,
    LSP_CREATE_JAVA_FILE_NAME,
    LSP_CREATE_PYTHON_FILE_NAME,
    LSP_CREATE_TYPESCRIPT_FILE_NAME,
    LSP_DELETE_GDSCRIPT_FILE_NAME,
    LSP_DELETE_JAVA_FILE_NAME,
    LSP_DELETE_PYTHON_FILE_NAME,
    LSP_DELETE_TYPESCRIPT_FILE_NAME,
    LSP_MUTATION_TOOLS,
    LSP_READ_TOOLS,
    LSP_UPDATE_GDSCRIPT_FILE_NAME,
    LSP_UPDATE_JAVA_FILE_NAME,
    LSP_UPDATE_PYTHON_FILE_NAME,
    LSP_UPDATE_TYPESCRIPT_FILE_NAME,
)
from clara_coder_backend.tools.staging_edit import STAGING_TOOLS
from clara_coder_backend.tools.write_jobs import WAIT_FOR_WRITE_NAME, write_job_tools
from clara_coder_backend.domain import SessionState
from clara_coder_backend.session.state import agent_formatters_enabled, direct_workspace_edits_active, runtime_config
from clara_coder_backend.context_packs.tool import ACTIVATE_CONTEXT_TOOLS
from clara_coder_backend.tools.workspace import TOOLS, TOOL_MAP, WORKSPACE_READ_TOOL_NAMES as _BASE_READ_NAMES

WORKSPACE_READ_TOOL_NAMES: frozenset[str] = _BASE_READ_NAMES | frozenset(
    t.name for t in ACTIVATE_CONTEXT_TOOLS
)


def merge_tools_replace_by_name(
    base_tools: list[Any],
    base_map: dict[str, Any],
    named_layers: list[tuple[str, list[Any]]],
) -> tuple[list[Any], dict[str, Any]]:
    """Later layers override ``base_map`` by tool ``name``; rebuild ``base_tools`` order with replacements applied.

    **Contract:** If a later layer lists a tool with the same ``name`` as an earlier tool, it should normally be the
    **same callable / LangChain tool object** as the base definition so descriptions and behavior cannot drift. Only
    replace with a different object when intentionally wrapping the tool; then align the wrapper docstring with the
    base tool so models do not see two conflicting explanations for one name.
    """
    out_map = dict(base_map)
    for _label, layer in named_layers:
        for tool in layer:
            out_map[tool.name] = tool
    out_tools = [out_map[t.name] for t in base_tools]
    base_names = {t.name for t in base_tools}
    for _label, layer in named_layers:
        for tool in layer:
            if tool.name not in base_names:
                out_tools.append(tool)
                base_names.add(tool.name)
    return out_tools, out_map


def staging_workspace_write_tools(edit_tools_strict: bool) -> list[Any]:
    """Staged create/update tools for the outer agent (snippet omitted when strict)."""
    if edit_tools_strict:
        return list(STAGING_TOOLS[:-1])
    return list(STAGING_TOOLS)


_LSP_CREATE_UPDATE_NAMES = frozenset(
    {
        LSP_CREATE_PYTHON_FILE_NAME,
        LSP_UPDATE_PYTHON_FILE_NAME,
        LSP_CREATE_TYPESCRIPT_FILE_NAME,
        LSP_UPDATE_TYPESCRIPT_FILE_NAME,
        LSP_CREATE_GDSCRIPT_FILE_NAME,
        LSP_UPDATE_GDSCRIPT_FILE_NAME,
        LSP_CREATE_JAVA_FILE_NAME,
        LSP_UPDATE_JAVA_FILE_NAME,
    }
)

_LSP_DELETE_NAMES = frozenset(
    {
        LSP_DELETE_PYTHON_FILE_NAME,
        LSP_DELETE_TYPESCRIPT_FILE_NAME,
        LSP_DELETE_GDSCRIPT_FILE_NAME,
        LSP_DELETE_JAVA_FILE_NAME,
    }
)


def hitl_diff_pause_tools(*, direct: bool = False) -> frozenset[str]:
    """Tool names that may emit a diff and require human review before the agent continues."""
    edit_strict = runtime_config.tools.edit_tools_strict
    if direct:
        from clara_coder_backend.tools.edit import edit_tools_for_strict

        names = {t.name for t in edit_tools_for_strict(edit_strict)}
        names |= _LSP_CREATE_UPDATE_NAMES
        if agent_formatters_enabled():
            names.add(FORMAT_WORKSPACE_FILE_BLACK_NAME)
            names.add(FORMAT_WORKSPACE_FILE_PRETTIER_NAME)
        # Staged→workspace transfer can still run under direct bindings (plan mode / auto-apply off).
        names.add(TRANSFER_STAGED_FILE_TO_WORKSPACE_NAME)
        return frozenset(names)
    names = {t.name for t in staging_workspace_write_tools(edit_strict)}
    names.add(TRANSFER_STAGED_FILE_TO_WORKSPACE_NAME)
    names.add(WAIT_FOR_WRITE_NAME)
    if agent_formatters_enabled():
        names.add(FORMAT_STAGING_FILE_BLACK_NAME)
        names.add(FORMAT_STAGING_FILE_PRETTIER_NAME)
    names |= _LSP_CREATE_UPDATE_NAMES
    return frozenset(names)


def hitl_delete_pause_tools() -> frozenset[str]:
    return frozenset({DELETE_WORKSPACE_ENTRY_NAME, BATCH_DELETE_WORKSPACE_ENTRIES_NAME}) | _LSP_DELETE_NAMES


def hitl_copy_pause_tools() -> frozenset[str]:
    return frozenset({COPY_WORKSPACE_FILES_NAME})


def hitl_accept_command_pause_tools() -> frozenset[str]:
    from clara_coder_backend.hitl.deferred_tool_hitl import DEFERRED_HITL_TOOL_NAMES

    return frozenset(DEFERRED_HITL_TOOL_NAMES)


def worker_tools_and_map(
    apply_mode: bool,
    *,
    session: SessionState | None = None,
    edit_tools_strict_override: bool | None = None,
) -> tuple[list[Any], dict[str, Any]]:
    """Tools for the outer Clara agent: reads; plus direct copy, staging writes, and Python LSP staging mutators when Editor is on.

    ``edit_tools_strict_override`` — when set, drives staged/direct write tools instead of runtime Settings.
  When ``session`` is provided and Editor + Auto-apply are on, binds direct workspace mutators instead of staging.
    """
    tools: list[Any] = [*TOOLS, *ACTIVATE_CONTEXT_TOOLS, *LSP_READ_TOOLS]
    mapping: dict[str, Any] = dict(TOOL_MAP)
    for tool_ in ACTIVATE_CONTEXT_TOOLS:
        mapping[tool_.name] = tool_
    for tool_ in LSP_READ_TOOLS:
        mapping[tool_.name] = tool_
    if getattr(runtime_config.tools, 'allow_web_access', False):
        from clara_coder_backend.tools.fetch_url import fetch_url_tool
        from clara_coder_backend.tools.web_search import web_search_tool

        tools.append(web_search_tool)
        mapping[web_search_tool.name] = web_search_tool
        tools.append(fetch_url_tool)
        mapping[fetch_url_tool.name] = fetch_url_tool
    if apply_mode:
        sess = session or SessionState()
        direct = direct_workspace_edits_active(sess, apply_mode=apply_mode)
        tools.append(copy_workspace_files)
        mapping[copy_workspace_files.name] = copy_workspace_files
        edit_strict = (
            edit_tools_strict_override
            if edit_tools_strict_override is not None
            else runtime_config.tools.edit_tools_strict
        )
        if direct:
            from clara_coder_backend.tools.edit import edit_tools_for_strict

            edit_tools = edit_tools_for_strict(edit_strict)
        else:
            edit_tools = staging_workspace_write_tools(edit_strict)
        tools.extend(edit_tools)
        for t in edit_tools:
            mapping[t.name] = t
        if not direct:
            for write_tool in write_job_tools():
                tools.append(write_tool)
                mapping[write_tool.name] = write_tool
        tools.extend(LSP_MUTATION_TOOLS)
        for t in LSP_MUTATION_TOOLS:
            mapping[t.name] = t
        tools.append(delete_workspace_entry)
        mapping[DELETE_WORKSPACE_ENTRY_NAME] = delete_workspace_entry
        tools.append(batch_delete_workspace_entries)
        mapping[BATCH_DELETE_WORKSPACE_ENTRIES_NAME] = batch_delete_workspace_entries
        from clara_coder_backend.tools.run_command import background_command_tools

        for command_tool in background_command_tools():
            tools.append(command_tool)
            mapping[command_tool.name] = command_tool
        from clara_coder_backend.tools.review_tools import staging_review_tools

        tools, mapping = merge_tools_replace_by_name(
            tools,
            mapping,
            [
                ('staging_review', staging_review_tools(direct=direct)[0]),
            ],
        )
    return tools, mapping


def planner_discovery_tools_and_map(
    *,
    session: SessionState | None = None,
) -> tuple[list[Any], dict[str, Any]]:
    """Read-only tool surface for plan-mode discovery (no writes, staging, or execute tools)."""
    return worker_tools_and_map(False, session=session)


# Ordered (label, members) registry: exact tool names and/or prefix tokens (trailing '_').
TOOL_FAMILIES: list[tuple[str, tuple[str, ...]]] = [
    (
        'Reads & search',
        (
            'list_workspace_directory',
            'retrieve_workspace_semantic',
            'retrieve_workspace_checkpoint_semantic',
            'search_workspace',
            'read_workspace_file',
            'read_workspace_image',
        ),
    ),
    ('Context packs', ('activate_context',)),
    ('Structured zoom (wsdl/xml/json)', ('wsdl_', 'xml_', 'json_')),
    ('LSP', ('lsp_',)),
    (
        'Edits (staging + direct)',
        (
            'stage_create_file',
            'stage_workspace_file_overwrite',
            'stage_line_range_edit',
            'stage_snippet_edit',
            'wait_for_write',
            'cancel_write',
            'list_write_jobs',
            'apply_workspace_full_file',
            'replace_workspace_line_range',
            'replace_workspace_snippet',
        ),
    ),
    (
        'Staging review',
        (
            'list_staged_edits',
            'diff_staged_edit_against_baseline',
            'read_staged_edit',
            'search_staged_edits',
            'format_staging_file_black',
            'format_staging_file_prettier',
            'format_workspace_file_black',
            'format_workspace_file_prettier',
            'run_staging_overlay_command',
            'transfer_staged_file_to_workspace',
            'reject_staged_workspace_edit',
            'discard_staged_edits',
        ),
    ),
    (
        'Web',
        (
            'web_search',
            'fetch_url',
        ),
    ),
    (
        'Process',
        (
            'run_command',
            'wait_for_command',
            'kill_background_command',
            'list_background_commands',
        ),
    ),
    ('Build plan', ('read_build_plan', 'mark_build_plan_steps_complete')),
    ('Other', ()),
]


def _family_for(name: str) -> str:
    """Classify a tool name into exactly one display family (fallback: Other)."""
    classified = TOOL_FAMILIES[:-1]
    for label, members in classified:
        if name in members:
            return label
    for label, members in classified:
        for member in members:
            if member.endswith('_') and name.startswith(member):
                return label
    return 'Other'


def _short_purpose(description: str) -> str:
    """First sentence/clause of a tool docstring, truncated for compact catalog lines."""
    desc = description.strip()
    if not desc:
        return '(no description)'
    for sep in ('. ', '\n'):
        if sep in desc:
            desc = desc.split(sep, 1)[0]
            break
    desc = desc.strip()
    if len(desc) > 90:
        desc = desc[:87].rstrip() + '...'
    return desc


def _tool_name(tool: Any) -> str:
    return getattr(tool, 'name', None) or getattr(tool, '__name__', 'unknown')


def format_tools_catalog(tools: list[Any]) -> str:
    """Grouped one-line tool summaries for planner/replanner prompts.

    Tools are bucketed by :data:`TOOL_FAMILIES` order. The first non-empty family
    omits its ``**header**`` so the catalog still starts with ``- \\`name\\` — …``
    (callers rely on ``catalog.startswith('- ')``).
    """
    buckets: dict[str, list[Any]] = {label: [] for label, _ in TOOL_FAMILIES}
    for tool in tools:
        buckets[_family_for(_tool_name(tool))].append(tool)

    lines: list[str] = []
    first_family = True
    for family, _ in TOOL_FAMILIES:
        group = buckets[family]
        if not group:
            continue
        if not first_family:
            lines.append(f'**{family}**')
        first_family = False
        for tool in group:
            name = _tool_name(tool)
            desc = getattr(tool, 'description', None) or ''
            lines.append(f'- `{name}` — {_short_purpose(desc)}')
    return '\n'.join(lines)
