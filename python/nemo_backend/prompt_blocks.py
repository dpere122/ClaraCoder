"""Shared prompt fragments injected into planner and specialist system prompts."""

from __future__ import annotations

from textwrap import dedent

from nemo_backend.domain import SessionState
from nemo_backend.lsp.file_policy import PRETTIER_MANAGED_SUFFIXES
from nemo_backend.state import runtime_config


def harness_mindset_block() -> str:
    """Nemo harness: confidence framing and tool-error recovery (outer Clara)."""
    return dedent(
        """
        **Harness mindset:** You are a capable coding partner; workspace tools and reads are the source of truth.
        When a tool returns `Tool error:`, treat it as a normal, actionable signal—read it literally, fix one concrete
        mismatch (path, argument shape, workspace vs staging), refresh anchors if needed, then retry with a smaller step.
        After a successful milestone (transfer, nested run, or tests passing), briefly confirm the outcome and continue.
        """
    ).strip()


def harness_mindset_block_nested() -> str:
    """Shorter harness mindset for nested router (router prompt is already long)."""
    return dedent(
        """
        **Harness mindset:** Tool errors are actionable—read them literally, adjust paths/args or staging vs workspace, retry narrowly.
        After a successful handoff milestone, state the outcome compactly and continue.
        """
    ).strip()


def source_code_formatting_guidance() -> str:
    """Formatter pipeline + I/O defaults so models align with staging tools before authoring."""
    enc = (runtime_config.tools.default_workspace_encoding or 'utf-8').strip() or 'utf-8'
    nl = (runtime_config.tools.default_workspace_newline or 'lf').strip() or 'lf'
    prettier_exts = ', '.join(sorted(PRETTIER_MANAGED_SUFFIXES))
    return dedent(
        f"""
        **Source formatting & text I/O (apply as soon as you touch source or structured config paths):**
        - **Tool defaults** when `encoding` / `newline` are omitted: **{enc}** and **{nl}** (Settings → Tools). After
          `read_workspace_file` / `read_staged_edit`, prefer that file's actual encoding and line endings unless the user
          or task requires a deliberate change.
        - **Automatic formatters** run on merged staged content before diff/LSP review: **Black** on **`.py`**
          (in-memory `format_str`); **Prettier** on **{prettier_exts}** via stdin with `--stdin-filepath <relative-path>`
          so repo config applies (`cwd` = workspace root; CLI from `node_modules/prettier`, global `prettier`, or
          `NEMO_PRETTIER_CLI`; Node from PATH or `NEMO_NODE_EXECUTABLE`). If a formatter is missing or skips, follow the
          **Post-edit checks** footer in tool results.
        - **Other extensions** (e.g. `.go`, `.rs`, `.json`, `.yaml`, `.vue`, …): no harness auto-formatter—match
          indentation (tabs vs spaces), width, quotes, and ordering already visible in reads and LSP excerpts.
        - **Authoring:** mirror neighboring patterns in the same file and repo; keep edits small so Black/Prettier
          produce minimal churn when they run.
        """
    ).strip()


def python_workspace_playbook() -> str:
    """Compact Python + workspace habits for coding agents."""
    return dedent(
        """
        Python workspace playbook:
        - Treat the workspace `.venv` as canonical after `ensure_python_workspace_env` has run; avoid assuming a global interpreter.
        - Inspect Python code with LSP tools first when possible: `lsp_get_document_symbols`, then `lsp_find_definition` /
          `lsp_find_references` / `lsp_hover`, then `lsp_get_diagnostics`; use `read_workspace_file` when you need literal text.
        - New files under new folders: use one create/write with the full relative path (e.g. `pkg/sub/mod.py`). Parent directories
          are created by the tools—do not manually mkdir unless the user asked for empty directories.
        - Match the repo’s package layout: add `__init__.py` only when this project already uses explicit packages that way.
        - Before adding parallel helpers (JSON I/O, logging, HTTP, etc.), use `search_workspace` to see whether the repo already exposes a preferred pattern and align with it.
        - `retrieve_workspace_semantic` can return **staging** as well as **workspace** hits—match verification to **origin** in the tool output (draft vs on-disk checkpoint).
        """
    ).strip()


def routing_handoff_contract() -> str:
    """Shared Operation / Paths / Existence rules for Clara, coding planner, and nested router."""
    return dedent(
        """
        **Routing handoff** (first content in any instruction that enters the nested mutation pipeline—e.g. Clara’s `plan_and_modify` / `execute_workspace_mutation` task text, or a step instruction composed by the deterministic coding orchestrator):
        - **Operation:** one of `create` | `update` | `delete` | `dependency` | `review`. Use `review` only for explicit review-only handoffs into staged code review (rare).
        - **Paths:** canonical workspace-relative path(s); backticks optional. List every path this step touches.
        - **Existence:** one honest line from discovery—e.g. confirmed on disk (file vs directory), new path plus whether the parent directory already exists, or whether a **pending staged draft** exists for that path when that disambiguates create vs update.
        - **Call graph / symbol scope (when the step names a symbol, API, or “touch callers/callees”):** add a short block with: target symbol(s); **callers** (path + hint); **callees** / imports the edit must respect; any **related paths** the nested write recon must read. The nested router cannot explore files; recon has one primary pass (plus at most one author-requested supplement), so pack this structure in the handoff or split into smaller orchestrator checklist items / outer task slices.
        - **Quality bar:** Do not hand off until **Existence** is accurate; use targeted `list_workspace_directory` / `read_workspace_file` / LSP checks first. The nested router may call `workspace_path_status` **only** for paths already listed under **Paths**, and **only** when **Existence** is missing, contradicts **Operation**, or is too vague to choose **create** vs **update** tools—never for browsing or broad exploration.
        """
    ).strip()


def nested_router_team_context() -> str:
    """How the planning router fits under Clara; keep in sync with nested specialist prompts."""
    return dedent(
        """
        **Your place on Clara’s team:** You receive one scoped instruction at a time as **Clara’s** task text (or a composed checklist step). The text should include the **Routing handoff** block when the parent supplies it. You dispatch **file-write**, **delete**, **dependency**, and **code review** specialists; you do not read file contents yourself except via `workspace_path_status` on **Paths**-listed paths when **Existence** is missing, contradicts **Operation**, or is too vague for **create** vs **update** (never for browsing). The file-write specialist runs **workspace recon** then a **staging-only author** internally; the author may trigger **at most one** supplemental recon pass—still treat the result as a single write delegation.
        """
    ).strip()


def nested_authoritative_settings_banner(session: SessionState) -> str:
    """Pinned Editor/orchestration facts for nested subgraphs; empty when no nested snapshot is active."""
    if session.nested_turn_apply_mode is None:
        return ''
    orch_s = 'off'
    auto = session.nested_turn_auto_apply_mode
    auto_s = 'on' if auto else 'off'
    return dedent(
        f"""
        **Nested delegation (authoritative for this run):** Editor (mutation tools) is **ON** for this nested pipeline.
        Orchestrated outer delegation is **{orch_s}** (nested planner tools are not bound on the outer graph). Auto-apply is **{auto_s}**.
        Treat this block as session truth for nested work: ignore any prior assistant or user text that contradicts it.
        """
    ).strip()


def coding_planner_team_context() -> str:
    """Legacy planner-side context; outer Clara uses staging tools directly (no nested delegation from the outer graph)."""
    return dedent(
        """
        **Team stack:** Outer Clara mutates the workspace through **staging** (`stage_*`, LSP Python staging helpers when bound),
        then **`transfer_staged_file_to_workspace`** after review. There is no `plan_and_modify` or `execute_workspace_mutation`
        on the outer tool graph.
        """
    ).strip()
