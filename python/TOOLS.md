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
so the scan pattern stays predictable for the model.

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
| `STAGE_LAND`        | `land_in_workspace` false-while-iterating / true-on-final |
| `VERIFY_LSP`        | verify with `lsp_get_diagnostics` (refresh on touched)  |
| `VERIFY_READ`       | verify hits with `read_workspace_file` / LSP / search    |

One token per mention, no drift across tools.

## 3. `Annotated[type, "hint"]` on params models get wrong

Push per-arg guidance into the JSON schema (where the model looks when picking
args) instead of bloating the top-level description. Add `Annotated[...]` hints
on at least these params:

- `relative_path` — `Annotated[str, RELATIVE_PATH]`
- `start_line` / `end_line` — `Annotated[int, ONE_BASED]`
- `encoding` — `Annotated[str, "empty = Settings default"]`
- `newline` — `Annotated[str, "lf | crlf | preserve (match existing)"]`
- `section_ref` — `Annotated[str, "from *_overview / search_*"]`
- `land_in_workspace` — `Annotated[bool, STAGE_LAND]`
- `relative_paths` — `Annotated[list[str], "list of POSIX paths"]`
- `old_snippet` / `new_snippet` — distinguish from `new_content` aliasing
- `command_argv_json` — `Annotated[str, "JSON array of argv strings"]`
- `command` — `Annotated[str, "shell command for run_command"]`

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

## 5. 18,000-token budget per mode

Bound tool schemas (via `convert_to_openai_tool`, `cl100k_base`) must stay
≤ **18,000 tokens** per mode. Enforced in CI by
`clara_coder_backend.tool_budget.assert_under_budget` via
`tests/test_tool_budget.py`:

```bash
python -m pytest python/tests/test_tool_budget.py -q
```

On failure the assertion prints a per-tool cost table (name + tokens, descending)
so the bloat source is obvious. Current baselines:

- `read_only` — ~4.1k
- `editor`    — ~12.6k
- `plan`      — ~12.7k

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
planner catalog stays organized. The catalog is currently ~7,200 chars
(≈1.8k tokens) for the full plan-mode set.

## 7. Single source for edit semantics

The per-extension LSP-mutator map and the `land_in_workspace` policy live in
**exactly one place**: `edit_semantics_block(direct=...)` in
`clara_coder_backend/llm/prompt_blocks.py`. It is injected **once** into the
assembled system prompt via `messages._outer_agent_operational_block`. Model
suffixes (`tool_calling_and_edit_semantics_suffix`) must not re-embed that
block—only API tool-channel / family-specific notes. Never re-state the
LSP-mutator map or staging-vs-direct policy in a tool docstring or another
prompt block — extend `edit_semantics_block` instead.
