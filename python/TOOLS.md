# nemo tool authoring standard

Single source of truth for how tools in `python/clara_coder_backend/tools/` are
described, parameterized, and kept under the per-mode token budget. Follow this
when adding or editing any tool.

## 1. Description template

Every tool description uses the uniform template, built with
`describe(...)` from `clara_coder_backend.tools.tool_conventions`:

```
purpose. When: … Not: … Shape: … Verify: …
```

- `purpose` — one short sentence: what the tool does.
- `When:` — the situation that should trigger the call.
- `Not:` — the close-but-wrong alternative (named tool or anti-pattern).
- `Shape:` — the arg shape that matters (ranges, units, formats).
- `Verify:` (optional) — the tool to call afterwards to confirm.

Never paste the template inline as bare prose. Always go through `describe()`
so the scan pattern stays predictable for the model. `describe()` normalizes
punctuation (one terminal stop per part, no `..` / `.;`), so pass fragments.

## 2. Compose, don't duplicate

Import the shared convention constants from
`clara_coder_backend.tools.tool_conventions` and compose them into `describe(...)`.
Do **not** re-state these rules in a tool docstring:

| Constant            | Replaces                                                |
| ------------------- | ------------------------------------------------------- |
| `ENCODING_NEWLINE`  | `encoding` default + `newline` lf/crlf/preserve policy  |
| `ONE_BASED`         | "lines are 1-based inclusive after `\n` normalization"  |
| `GUTTER`            | `n │ text` gutter + `include_line_numbers=false` caveat |
| `RELATIVE_PATH`     | "workspace-relative POSIX path"                         |
| `VERIFY_LSP`        | `lsp_get_diagnostics` (refresh on touched paths)         |
| `VERIFY_READ`       | `read_workspace_file` / LSP / search on the hits         |

Constants are fragments without a trailing period. Prefer putting a rule in the
`Annotated` hint of the parameter it governs over repeating it in `shape=`.

Result size: cap tool output with `tool_output_cap()` and clip single lines with
`clip_line()` (both in `tool_conventions`) instead of per-tool ad-hoc limits.

## 3. `Annotated[type, "hint"]` on params models get wrong

Push per-arg guidance into the JSON schema (where the model looks when picking
args) instead of bloating the top-level description. Add `Annotated[...]` hints
on at least these params:

- `relative_path` — `Annotated[str, RELATIVE_PATH]`
- `start_line` / `end_line` — `Annotated[int, ONE_BASED]`
- `encoding` — `Annotated[str, "empty = Settings default"]`
- `newline` — `Annotated[str, "lf | crlf | preserve (match existing)"]`
- `section_ref` — `Annotated[str, "from structured_overview / search_structured"]`
- `relative_paths` — `Annotated[list[str], f"list of {RELATIVE_PATH}s"]`
  (put `| None` **inside** `Annotated[...]` or the hint is dropped from the schema)
- `old_snippet` / `new_snippet` — one name per meaning; no aliases
- `command` — `Annotated[str, "shell command line"]`

## 4. `@tool(NAME, description=describe(...))`

Python f-strings assigned to a docstring are **not** real docstrings — LangChain
won't pick them up. Pass the description explicitly:

```python
from langchain_core.tools import tool
from clara_coder_backend.tools.tool_conventions import describe, RELATIVE_PATH, ONE_BASED

my_tool = tool(
    MY_TOOL_NAME,
    description=describe(
        "Read a workspace file slice.",
        when="you need file contents at specific lines.",
        not_="semantic recall (use retrieve_workspace_semantic).",
        shape=f"{ONE_BASED} {GUTTER}",
        verify=VERIFY_READ,
    ),
)(my_tool_impl)
```

## 5. 9,000-token budget per mode

Bound tool schemas (via `convert_to_openai_tool`, `cl100k_base`, MCP tools
excluded) must stay ≤ **9,000 tokens** per mode (`TOOL_BUDGET_CAP`). Enforced in
CI by `clara_coder_backend.hitl.tool_budget.assert_under_budget` via
`tests/test_tool_budget.py` (including the editor + web + formatters worst case):

```bash
python -m pytest python/tests/test_tool_budget.py -q
```

On failure the assertion prints a per-tool cost table (name + tokens, descending)
so the bloat source is obvious. Current baselines:

- `read_only` — ~3.0k (15 tools)
- `editor`    — ~5.3k (25 tools)
- `plan`      — ~5.4k
- `editor` + web + formatters — ~5.6k

If a description change pushes a mode over the cap, compose with shared
constants or move detail into `Annotated` param hints rather than dropping
information silently.

## 6. Plan-mode catalog: grouped one-line summaries

`format_tools_catalog` (in `clara_coder_backend.hitl.tool_registry`) emits grouped
one-line summaries bucketed by `TOOL_FAMILIES` — **not** full descriptions.
This avoids duplicating the schema text in the planner prompt. Each line:

```
- `tool_name` — short first-clause purpose
```

When adding a tool, add its name to the right `TOOL_FAMILIES` bucket so the
planner catalog stays organized.

## 7. Single source for edit semantics

Edits write straight to disk (`clara_coder_backend/tools/edit.py`): no staging,
landing step or diff card. The first mutation of each path per turn emits a
`file_journal` row; Electron keeps those per turn so the user can review and
reset that turn's files after the reply. Auto Run gates only command / web /
MCP approval cards, never edits.

That policy lives in **exactly one place**: `edit_semantics_block()` in
`clara_coder_backend/llm/prompt_blocks.py`, injected **once** via
`messages._outer_agent_operational_block`. Model suffixes must not re-embed it,
and tool descriptions must not restate it—extend `edit_semantics_block` instead.
New mutating tools must journal through `session/file_journal.py`
(`emit_edit_journal` / `emit_file_journal`) so their changes are resettable.

## 8. Context packs (deferred workflow knowledge)

Long per-family playbooks (when to use overview→search→section, PDF page
semantics, etc.) belong in **context packs**, not always-on operational prose.

- Module: `clara_coder_backend/context_packs/`
- Register with `register_pack(ContextPack(...))` from the pack module
- Attach `tool_prefixes` and/or `tool_names` (+ optional `path_suffixes`) so the
  pack **auto-activates** on first matching tool use
- Advertise a one-line `summary` in the system-prompt catalog; keep the deep
  `body` out of the default system prompt
- Explicit load: bound tool `activate_context(pack_id)`
- Add the tool name to the `Context packs` bucket in `TOOL_FAMILIES` when
  introducing related meta-tools

Do **not** grow `_outer_agent_operational_block` with family playbooks—extend a
pack instead. Tool `describe()` / `Annotated` hints stay for existence and arg
shape; packs carry workflow knowledge.
