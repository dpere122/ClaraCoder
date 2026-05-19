"""LangChain message conversion, assistant text extraction, and system prompt.

Turns stored session history dicts into :class:`~langchain_core.messages.BaseMessage`
instances and builds the long system prompt (workspace + host + connection hints).
"""

from __future__ import annotations

import re
import json
import xml.etree.ElementTree as ET
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage

from nemo_backend.domain import SessionState
from nemo_backend.model_tuning import combined_model_prompt_suffix
from nemo_backend.prompt_blocks import (
    harness_mindset_block,
    routing_handoff_contract,
    source_code_formatting_guidance,
)
from nemo_backend.state import get_active_connection, runtime_config

# Precompiled patterns for detecting "pseudo" tool syntax in plain model text.
_RE_PSEUDO_FUNCTION_TAG = re.compile(r'<\s*function\s*=', re.IGNORECASE)
_RE_PSEUDO_PARAMETER_TAG = re.compile(r'<\s*parameter\s*=', re.IGNORECASE)
_RE_FUNCTION_EQ_TAG = re.compile(
    r'<\s*function\s*=\s*(?:"(?P<dq>[^"]+)"|\'(?P<sq>[^\']+)\'|(?P<bare>[^\s>/]+))\s*(?P<self>/?)\s*>',
    re.IGNORECASE,
)
_RE_PARAMETER_EQ_TAG = re.compile(
    r'<\s*parameter\s*=\s*(?:"(?P<dq>[^"]+)"|\'(?P<sq>[^\']+)\'|(?P<bare>[^\s>/]+))\s*(?P<self>/?)\s*>',
    re.IGNORECASE,
)
_RE_JSON_LIKE = re.compile(r'^\s*[\[{"]')


def session_to_messages(session: SessionState) -> list[BaseMessage]:
    """Map session.history entries to LangChain message objects for the LLM."""
    result: list[BaseMessage] = []
    for item in session.history:
        role = item.get('role', 'user')
        content: Any = item.get('content', '')
        if role == 'assistant':
            result.append(AIMessage(content=content))
        elif role == 'system':
            result.append(SystemMessage(content=content))
        else:
            result.append(HumanMessage(content=content))
    return result


def outer_turn_authority_preamble(session: SessionState, apply_mode: bool) -> str:
    """Compact live-settings block prepended to each outer Clara turn so the model attends to current truth."""
    from nemo_backend.state import direct_workspace_edits_active

    editor_s = 'on' if apply_mode else 'off'
    auto_s = 'on' if session.auto_apply_mode else 'off'
    direct_s = 'on' if direct_workspace_edits_active(session, apply_mode=apply_mode) else 'off'
    overlap = session.active_editor_langgraph_streams > 0
    overlap_line = (
        '\n- Other concurrent Editor streams in this session: **yes** (another turn may still be writing).'
        if overlap
        else ''
    )
    return (
        '**Session truth (authoritative for this message; older assistant replies may be outdated):**\n'
        f'- Editor (toolbar, this turn): **{editor_s}**\n'
        f'- Auto-apply (UI): **{auto_s}**\n'
        f'- Direct workspace writes (Editor + Auto-apply): **{direct_s}**'
        f'{overlap_line}\n'
        '- If any line above conflicts with earlier assistant prose in this chat, trust **this block** and the **current** '
        'system instructions—not stale narration.\n'
    )


def compose_outer_turn_human_content(
    session: SessionState,
    apply_mode: bool,
    user_message: str | list[dict[str, Any]],
) -> str | list[dict[str, Any]]:
    """Prepend :func:`outer_turn_authority_preamble` to the outer agent user turn (string or multimodal list)."""
    preamble = outer_turn_authority_preamble(session, apply_mode)
    if isinstance(user_message, str):
        return f'{preamble}\n{user_message}'
    merged: list[dict[str, Any]] = list(user_message)
    if not merged:
        return [{'type': 'text', 'text': preamble}]
    first = merged[0]
    if isinstance(first, dict) and str(first.get('type') or '').lower() == 'text':
        base = str(first.get('text') or '')
        merged[0] = {**first, 'text': f'{preamble}\n{base}'}
        return merged
    merged.insert(0, {'type': 'text', 'text': f'{preamble}\n'})
    return merged


def stringify_content(content: Any) -> str:
    """Normalize multimodal or structured message content to a single string."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
                continue
            if isinstance(item, dict):
                text = item.get('text') or item.get('content')
                if text:
                    parts.append(str(text))
                    continue
                kind = str(item.get('type') or '').strip()
                if kind:
                    parts.append(f'[{kind}]')
                continue
            text = getattr(item, 'text', None)
            if text:
                parts.append(str(text))
        return ''.join(parts)
    return str(content or '')


def _reasoning_body(message: AIMessage) -> str:
    """Extract provider reasoning / thinking text from AIMessage (multiple possible shapes)."""
    r = getattr(message, 'reasoning', None)
    if isinstance(r, str) and r.strip():
        return r.strip()
    ak = getattr(message, 'additional_kwargs', None) or {}
    for key in ('reasoning_content', 'reasoning'):
        val = ak.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
        if isinstance(val, dict):
            for sub in ('summary', 'text', 'content'):
                s = val.get(sub)
                if isinstance(s, str) and s.strip():
                    return s.strip()
    return ''


def assistant_visible_answer(message: AIMessage) -> str:
    """User-visible assistant text from normal content only (no reasoning-channel fallback)."""
    via_lc = str(getattr(message, 'text', None) or '').strip()
    return via_lc if via_lc else stringify_content(message.content).strip()


def final_assistant_text(message: AIMessage) -> str:
    """Text the agent loop treats as the model's answer (content, or reasoning if content empty)."""
    vis = assistant_visible_answer(message)
    if vis:
        return vis
    return _reasoning_body(message)


def reasoning_sidecar_text(message: AIMessage) -> str:
    """Reasoning to show separately when the model also returned a visible main answer."""
    body = _reasoning_body(message)
    if not body:
        return ''
    vis = assistant_visible_answer(message)
    if not vis:
        return ''
    if body.strip() == vis.strip():
        return ''
    return body


def text_uses_pseudo_tool_markup(text: str) -> bool:
    """True when the model wrote tool usage as prose/XML but sent no structured tool_calls."""
    if not text or not text.strip():
        return False
    if '<tool_call' in text and '</tool_call>' in text:
        return True
    if _RE_PSEUDO_FUNCTION_TAG.search(text):
        return True
    if _RE_PSEUDO_PARAMETER_TAG.search(text):
        return True
    return False


def _normalize_pseudo_tool_xml(text: str) -> str:
    def _replace_function(match: re.Match[str]) -> str:
        name = (match.group('dq') or match.group('sq') or match.group('bare') or '').strip()
        self_close = bool((match.group('self') or '').strip())
        end = ' />' if self_close else '>'
        return f'<function name="{name}"{end}'

    def _replace_parameter(match: re.Match[str]) -> str:
        name = (match.group('dq') or match.group('sq') or match.group('bare') or '').strip()
        self_close = bool((match.group('self') or '').strip())
        end = ' />' if self_close else '>'
        return f'<parameter name="{name}"{end}'

    out = _RE_FUNCTION_EQ_TAG.sub(_replace_function, text)
    out = _RE_PARAMETER_EQ_TAG.sub(_replace_parameter, out)
    return out


def _coerce_argument_value(raw: str) -> Any:
    value = raw.strip()
    if not value:
        return ''
    if not _RE_JSON_LIKE.match(value):
        return value
    try:
        parsed = json.loads(value)
    except Exception:
        return value
    return parsed


def _json_args_from_text(raw: str) -> tuple[str, dict[str, Any]]:
    payload = raw.strip()
    if not payload:
        return '', {}
    try:
        data = json.loads(payload)
    except Exception:
        return '', {}
    if not isinstance(data, dict):
        return '', {}
    name = str(data.get('name') or data.get('function') or data.get('tool') or '').strip()
    args = data.get('arguments')
    if not isinstance(args, dict):
        args = data.get('args')
    if not isinstance(args, dict):
        args = data.get('input')
    if not isinstance(args, dict):
        args = {}
    return name, dict(args)


def _parse_argument_nodes(node: ET.Element) -> dict[str, Any]:
    args: dict[str, Any] = {}
    for param in node.findall('.//parameter'):
        key = str(param.get('name') or '').strip()
        if not key:
            continue
        args[key] = _coerce_argument_value(''.join(param.itertext()))
    for container_name in ('arguments', 'args', 'input'):
        for container in node.findall(f'.//{container_name}'):
            text = ''.join(container.itertext()).strip()
            if not text:
                continue
            try:
                parsed = json.loads(text)
            except Exception:
                continue
            if isinstance(parsed, dict):
                args.update(parsed)
    return args


def _parse_tool_call_node(node: ET.Element) -> tuple[str, dict[str, Any]]:
    tag = node.tag.lower()
    if tag == 'function':
        name = str(node.get('name') or '').strip()
        args = _parse_argument_nodes(node)
        if not args:
            _unused_name, json_args = _json_args_from_text(''.join(node.itertext()))
            args = json_args
        return name, args

    if tag != 'tool_call':
        return '', {}

    nested_fn = node.find('./function')
    if nested_fn is not None:
        name, args = _parse_tool_call_node(nested_fn)
        if args:
            return name, args
        merged = _parse_argument_nodes(node)
        if merged:
            return name, merged
        return name, {}

    direct_name = str(node.get('name') or node.get('function') or '').strip()
    direct_args = _parse_argument_nodes(node)
    if direct_name and direct_args:
        return direct_name, direct_args
    json_name, json_args = _json_args_from_text(''.join(node.itertext()))
    if json_name:
        return json_name, json_args
    return direct_name, direct_args


def extract_pseudo_tool_calls(text: str) -> list[dict[str, Any]]:
    """Best-effort conversion of pseudo XML tool syntax into LangChain-style ``tool_calls``."""
    if not text_uses_pseudo_tool_markup(text):
        return []
    normalized = _normalize_pseudo_tool_xml(text)
    try:
        root = ET.fromstring(f'<root>{normalized}</root>')
    except ET.ParseError:
        return []

    parent_by_child: dict[ET.Element, ET.Element] = {child: parent for parent in root.iter() for child in parent}
    out: list[dict[str, Any]] = []
    for node in root.iter():
        tag = node.tag.lower()
        if tag == 'function' and parent_by_child.get(node, root).tag.lower() == 'tool_call':
            continue
        if tag not in ('tool_call', 'function'):
            continue
        name, args = _parse_tool_call_node(node)
        tool_name = name.strip()
        if not tool_name:
            continue
        out.append(
            {
                'name': tool_name,
                'args': args if isinstance(args, dict) else {},
                'id': f'xml-tool-{len(out) + 1}',
            }
        )
    return out


_STAGING_TREE_SECTION_MARKER = '\n\nNested edit staging tree ('


def _workspace_context_without_staging(workspace_context: str) -> str:
    """Strip the appended staging-tree section from a combined workspace/staging snapshot."""
    if not workspace_context:
        return ''
    before, marker, _after = workspace_context.partition(_STAGING_TREE_SECTION_MARKER)
    if not marker:
        return workspace_context
    return before.rstrip()


def _workspace_hint(session: SessionState, *, include_staging: bool = False) -> str:
    if not session.workspace_path:
        return 'No workspace is attached to this conversation.'
    workspace_context = session.workspace_context or ''
    if not include_staging:
        workspace_context = _workspace_context_without_staging(workspace_context)
    label = 'Workspace context snapshot' if include_staging else 'Workspace tree snapshot'
    return (
        f'Workspace path: {session.workspace_path}\n\n'
        f'{label}:\n{workspace_context or "[empty]"}'
    )


def _connection_line(session: SessionState) -> str:
    connection = get_active_connection()
    return (
        f'Active model connection: {connection.name} ({connection.provider}, model={connection.model}).'
    )


def _model_prompt_suffix(session: SessionState, apply_mode: bool) -> str:
    """Universal tool/edit semantics plus optional parallel-batching and Qwen-specific lines."""
    return combined_model_prompt_suffix(get_active_connection(), session=session, apply_mode=apply_mode)


def _os_hint_line() -> str:
    host = runtime_config.host
    if not host.platform:
        return 'Host operating system: unavailable.'
    return (
        f'Host operating system: {host.label or host.platform} '
        f'(platform={host.platform}, release={host.release or "unknown"}, '
        f'version={host.version or "unknown"}, arch={host.arch or "unknown"}).'
    )


def _outer_agent_operational_block(session: SessionState, apply_mode: bool) -> str:
    """Outer Clara: reads/search; direct copy; staging and specialist tools when Editor is on."""
    from nemo_backend.state import direct_workspace_edits_active

    direct = direct_workspace_edits_active(session, apply_mode=apply_mode)
    base = (
        'Operational guidance:\n'
        '- For codebase questions, inspect the workspace before making claims.\n'
        '- After checking the workspace tree, resolve uncertainty with tools rather than long speculation; if blocked, '
        'state the single missing fact and the next tool you would call.\n'
        '- If a tool returns partial data, say what is missing.\n'
        '- When your answer refers to code or files, name the relevant paths clearly.\n'
        '- Match shell guidance to the detected host OS; do not assume Bash is available on Windows.\n'
        '- If no workspace is loaded, say that no local files were available.\n'
        '- Read-only inspection: start with the workspace tree in your system instructions above for structure and likely file paths. '
        'Use `list_workspace_directory` only when that tree is insufficient, stale, or you need to confirm a specific subtree.\n'
        '- Discovery / reads (follow each bound tool’s description for details):\n'
        '  1. Unknown targets → `retrieve_workspace_semantic`, then verify each hit’s `origin`.\n'
        '  2. origin=workspace → `read_workspace_file` / LSP / `search_workspace` (disk).\n'
        + (
            '  3. Semantic hits are workspace-only in direct-write mode—use `read_workspace_file` / LSP on disk.\n'
            if direct
            else '  3. origin=staging → `read_staged_edit` or `diff_staged_edit_against_baseline` (not disk `read_workspace_file` until `transfer_staged_file_to_workspace`).\n'
        )
        + (
            '  4. Exact grep: use `search_workspace` on disk.\n'
            if direct
            else '  4. Exact grep: disk → `search_workspace`; staged drafts only → `search_staged_edits`.\n'
        )
        + '  5. Known `.py`/`.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs` paths → prefer LSP reads/diagnostics before heavy file reads; literal spans → `read_workspace_file`.\n'
        + '  6. `.pdf`: `read_workspace_file` uses `start_line`/`end_line` as 1-based page numbers.\n'
        + '- Text encoding/newlines: `read_workspace_file` / `search_workspace` accept `encoding`; nested edit tools accept `encoding` '
        'and `newline` (lf, crlf, preserve). Defaults come from app Settings → Tools.\n'
    )
    if not apply_mode:
        return (
            base
            + '- **Backend (authoritative):** Editor mode is **OFF** for this turn; workspace mutation and staging '
            'tools are not bound. Ignore any stale prior assistant text that claims Editor is on or lists write tools.\n'
            '- Editor mode is off: workspace write tools are not available\u2014use read-only tools only. '
            'If the user wants patches or deletes from chat, ask them to enable Editor in the toolbar.\n'
        )
    if direct:
        return (
            base
            + '- **Backend (authoritative):** Editor mode is **ON** and Auto-apply is **ON**; **direct workspace writes** '
            'are bound (no staging or transfer tools).\n'
            + '- Use `apply_workspace_full_file`, `replace_workspace_line_range`, and `replace_workspace_snippet` '
            '(when bound) for text edits; for `.py` prefer `lsp_create_python_file`, `lsp_update_python_file`, and '
            '`lsp_delete_python_file` (writes land on disk immediately).\n'
            + '- `read_workspace_file` and LSP reads/diagnostics reflect the **on-disk workspace**—there is no staging draft plane.\n'
            + '- Verify with `lsp_get_diagnostics` (`refresh_active_document=true` on touched paths) and '
            '`run_workspace_pytest_tests` / `run_workspace_python_smoke_test` / `run_staging_overlay_command` '
            '(runs in the live workspace when overlay commands are enabled).\n'
            + '- **Python dependencies**, **Node/npm** tools, and **`angular_cli_tool`** are available when needed.\n'
            + '- Use `copy_workspace_files` only when duplicating existing files to new paths.\n'
            + '- Prefer **small, verifiable** edits; re-read files or refresh LSP between dependent changes.\n'
            + '- Summarize outcomes clearly (paths touched, what changed). Do not paste raw tool dumps.\n'
            f'{routing_handoff_contract()}\n'
            + '- **Inspect–integrate–mutate–verify:** Base **Existence** on `read_workspace_file` / LSP before mutating.\n'
        )
    return (
        base
        + '- **Backend (authoritative):** Editor mode is **ON**; staging and mutation tools below are bound.\n'
        + '- You have read/search tools, `copy_workspace_files`, `delete_workspace_entry` and `batch_delete_workspace_entries`, '
        '**staged** create/update tools (`stage_create_file`, `stage_workspace_file_overwrite`, `stage_line_range_edit`, '
        'and `stage_snippet_edit` when bound), Python LSP staging mutators (`lsp_create_python_file`, '
        '`lsp_update_python_file`, `lsp_delete_python_file`) for `.py`, review/transfer tools, dependency installs, '
        'workspace tests, and staging-focused specialist tools (`code_review_specialist_*`, etc.). '
        'Use the **staging pipeline** for all programming-path and structured-config edits.\n'
        '- **Direct writes on this graph:** Use `stage_*` for staged edits on any path; for `.py` you may also use '
        '`lsp_create_python_file`, `lsp_update_python_file`, and `lsp_delete_python_file` (same staging/review path). '
        'LSP **read** and **diagnostics** tools for supported extensions are available.\n'
        '- **Workspace checkpoint:** `read_workspace_file` shows the **on-disk workspace**. Pending edits live in '
        '**staging** until `transfer_staged_file_to_workspace` succeeds—use `list_staged_edits`, '
        '`diff_staged_edit_against_baseline`, and `read_staged_edit` to inspect drafts.\n'
        '- **Source code and structured config** (`.py`, `.ts`, `.json`, `.yaml`, …): stage changes, run review/diagnostics '
        'on drafts, then **`transfer_staged_file_to_workspace`**—same as other text files.\n'
        '- **All other text files** (e.g. .md, .txt): same staging tools and **`transfer_staged_file_to_workspace`** '
        'after review.\n'
        '- **Python dependencies**, **Node/npm** tools, and **`angular_cli_tool`** (local `node_modules/.bin/ng` only—run '
        '`npm_install_project` for that folder first when `@angular/cli` is not yet installed) are available when you need them.\n'
        '- **Workspace verification:** you may call `run_workspace_pytest_tests` or `run_workspace_python_smoke_test` '
        'for Python checks.\n'
        '- Use `copy_workspace_files` only when you need to duplicate existing workspace files to new paths.\n'
        '- Read and inspect relevant files before editing. Prefer **small, verifiable** staging steps; refresh anchors '
        'from `read_staged_edit` or diff tools between dependent edits.\n'
        '- **After** transferring touched **Python or TS/JS** paths, call `lsp_get_diagnostics` '
        '(use `refresh_active_document=true` to re-read the on-disk file in workspace scope) before claiming the change is clean.\n'
        '- The user may review diffs or confirm copy/delete actions in the UI unless auto-apply is enabled.\n'
        '- Summarize outcomes clearly (paths touched, what changed). Do not paste raw tool dumps.\n'
        f'{routing_handoff_contract()}\n'
        '- **Inspect–integrate–mutate–verify:** Base **Existence** on tools—for **update** (or when a path might already exist), '
        'use `read_workspace_file` and/or LSP reads on those paths first so you augment or replace real content, not a guess. '
        'When adding I/O, config, logging, or helpers, use `search_workspace` to find existing patterns and reuse them when they fit.\n'
    )


def build_system_prompt(
    session: SessionState,
    apply_mode: bool,
) -> str:
    """Assemble Clara's system prompt: role, tools policy, connection, OS, workspace."""
    workspace_hint = _workspace_hint(session)
    operational = _outer_agent_operational_block(session, apply_mode)
    formatting_early = (
        f'{source_code_formatting_guidance()}\n\n' if (session.workspace_path or '').strip() else ''
    )
    return (
        'You are Clara, a coding assistant.'
        'Use the available tools whenever a request depends on inspecting or searching the workspace. '
        'Prefer quoting exact file paths, line numbers, commands, and concrete next steps. '
        'Keep answers concise but useful, and explain what you actually inspected.\n\n'
        f'{harness_mindset_block()}\n\n'
        f'{_connection_line(session)}\n\n'
        f'{_os_hint_line()}\n\n'
        f'{operational}'
        f'{formatting_early}'
        f'{workspace_hint}'
        f'{_model_prompt_suffix(session, apply_mode)}'
    )
