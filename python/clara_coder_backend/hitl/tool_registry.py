"""Central registry for LangChain tools and human-in-the-loop (HITL) policy.

**Outer agent:**
- Workspace reads, search and semantic recall.
- LSP reads and diagnostics.
- With Editor on: the write-through edit tools in :mod:`clara_coder_backend.tools.edit`
  (``write_workspace_file``, ``replace_workspace_lines``, optional ``replace_workspace_snippet`` and
  ``format_workspace_file``), plus ``copy_workspace_files``, ``delete_workspace_entries`` and
  ``java_bootstrap_project``.
- With Editor on: background ``run_command`` jobs and MCP tools.
- Agent-mode chat turns of a main session: ``spawn_subagent``, ``wait_for_subagents``, ``stop_subagent``.
  Sub-agents get none of them, nor ``propose_theme``.

Edits, copies and deletes land on disk immediately and are journaled per turn. The user reviews and resets
them after the reply. There is no staging, transfer step or diff card.

**HITL:**
- ``run_command``, ``web_search``, ``fetch_url`` and MCP tools pause on an accept-command card unless Auto Run
  is on (see :mod:`clara_coder_backend.hitl.deferred_tool_hitl`).
- ``run_command`` with ``elevate`` or a leading ``sudo`` stages the Admin grant card even with Auto Run on.
- A directory delete too large to journal always asks first.
"""

from __future__ import annotations

from typing import Any

from clara_coder_backend.tools.copy import copy_workspace_files
from clara_coder_backend.tools.delete import DELETE_WORKSPACE_ENTRIES_NAME, delete_workspace_entries
from clara_coder_backend.tools.edit import edit_tools
from clara_coder_backend.tools.lsp_tools import LSP_READ_TOOLS
from clara_coder_backend.tools.java_bootstrap import java_bootstrap_project
from clara_coder_backend.domain import SessionState
from clara_coder_backend.session.state import runtime_config
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


def hitl_delete_pause_tools() -> frozenset[str]:
    return frozenset({DELETE_WORKSPACE_ENTRIES_NAME})


def accept_command_pause_applies(name: str) -> bool:
    """True for built-in accept-command tools and for prefixed MCP tools."""

    from clara_coder_backend.mcp.names import is_mcp_tool_name

    return name in hitl_accept_command_pause_tools() or is_mcp_tool_name(name)


def hitl_accept_command_pause_tools() -> frozenset[str]:
    from clara_coder_backend.hitl.deferred_tool_hitl import DEFERRED_HITL_TOOL_NAMES

    return frozenset(DEFERRED_HITL_TOOL_NAMES)


def worker_tools_and_map(
    apply_mode: bool,
    *,
    session: SessionState | None = None,
    edit_tools_strict_override: bool | None = None,
    include_subagent_tool: bool = False,
) -> tuple[list[Any], dict[str, Any]]:
    """Tools for the outer Clara agent: reads always; mutators, commands and MCP when Editor is on.

    ``edit_tools_strict_override`` — when set, drives the snippet-tool omission instead of runtime Settings.
    ``include_subagent_tool`` — bind the sub-agent tools (``spawn_subagent``, ``wait_for_subagents``,
    ``stop_subagent``; the chat turn of a main session, plan mode never). A sub-agent ``session`` never gets
    them or ``propose_theme``.
    The bound set never depends on Auto Run: that toggle only skips command approval cards.
    """
    from clara_coder_backend.theme.propose_theme import propose_theme_tool
    from clara_coder_backend.tools.user_terminals import check_user_terminals_tool

    is_subagent = bool(session is not None and session.subagent_parent_session_id)
    tools: list[Any] = [
        *TOOLS,
        *ACTIVATE_CONTEXT_TOOLS,
        *LSP_READ_TOOLS,
        check_user_terminals_tool,
    ]
    if not is_subagent:
        tools.append(propose_theme_tool)
    if include_subagent_tool and not is_subagent:
        from clara_coder_backend.tools.spawn_subagent import spawn_subagent_tool
        from clara_coder_backend.tools.subagent_control import stop_subagent_tool, wait_for_subagents_tool

        tools.extend([spawn_subagent_tool, wait_for_subagents_tool, stop_subagent_tool])
    if getattr(runtime_config.tools, 'allow_web_access', False):
        from clara_coder_backend.tools.fetch_url import fetch_url_tool
        from clara_coder_backend.tools.web_search import web_search_tool

        tools.extend([web_search_tool, fetch_url_tool])
    if apply_mode:
        strict = (
            edit_tools_strict_override
            if edit_tools_strict_override is not None
            else runtime_config.tools.edit_tools_strict
        )
        from clara_coder_backend.mcp.tools import bound_mcp_tools
        from clara_coder_backend.tools.run_command import background_command_tools

        tools.extend(edit_tools(strict=strict))
        tools.extend([copy_workspace_files, delete_workspace_entries, java_bootstrap_project])
        tools.extend(background_command_tools())
        # MCP tools can have any side effect, and allow-all trust runs them without a card,
        # so read-only surfaces (Ask mode, plan discovery) never bind them.
        tools.extend(bound_mcp_tools())
    mapping: dict[str, Any] = dict(TOOL_MAP)
    mapping.update({t.name: t for t in tools})
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
            'search_workspace',
            'read_workspace_file',
            'read_workspace_image',
        ),
    ),
    ('Context packs', ('activate_context',)),
    (
        'Structured zoom (wsdl/xml/json)',
        ('structured_overview', 'search_structured', 'read_structured_section', 'wsdl_', 'xml_', 'json_'),
    ),
    ('LSP', ('lsp_',)),
    (
        'Edits',
        (
            'write_workspace_file',
            'replace_workspace_lines',
            'replace_workspace_snippet',
            'format_workspace_file',
            'copy_workspace_files',
            'delete_workspace_entries',
            'java_bootstrap_project',
        ),
    ),
    ('Web', ('web_search', 'fetch_url')),
    (
        'Process',
        (
            'check_user_terminals',
            'run_command',
            'wait_for_command',
            'kill_background_command',
            'list_background_commands',
        ),
    ),
    ('Build plan', ('read_build_plan', 'mark_build_plan_steps_complete')),
    ('Sub-agents', ('spawn_subagent', 'wait_for_subagents', 'stop_subagent')),
    ('App theme', ('propose_theme',)),
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
