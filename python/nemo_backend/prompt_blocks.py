"""Shared prompt fragments injected into planner and specialist system prompts."""

from __future__ import annotations

from textwrap import dedent

from nemo_backend.domain import SessionState


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
    """How the planning router fits under Clara; keep in sync with coding planner and outer prompts."""
    return dedent(
        """
        **Your place on Clara’s team:** You receive one scoped instruction at a time. It usually comes from the **deterministic coding orchestrator** (one composed instruction per checklist step when `plan_and_modify` runs the planner); otherwise from **`execute_workspace_mutation`**, or from **`plan_and_modify`** when the planner is disabled—all as **Clara’s** outer task text. In all cases the text should already include the **Routing handoff** block printed above. You dispatch **file-write**, **delete**, **dependency**, and **code review** specialists; you do not read file contents yourself except via `workspace_path_status` on **Paths**-listed paths when **Existence** is missing, contradicts **Operation**, or is too vague for **create** vs **update** (never for browsing). The file-write specialist runs **workspace recon** then a **staging-only author** internally; the author may trigger **at most one** supplemental recon pass—still treat the result as a single write delegation. **Whole-workspace final project review** (pytest/smoke, approve/reject) is **not** your job—the orchestrator runs that **after the full checklist** for the current phase completes, not after each nested call.
        """
    ).strip()


def nested_authoritative_settings_banner(session: SessionState) -> str:
    """Pinned Editor/orchestration facts for nested subgraphs; empty when no nested snapshot is active."""
    if session.nested_turn_apply_mode is None:
        return ''
    orch = session.nested_turn_orchestrated_mode
    auto = session.nested_turn_auto_apply_mode
    orch_s = 'on' if orch else 'off'
    auto_s = 'on' if auto else 'off'
    return dedent(
        f"""
        **Nested delegation (authoritative for this run):** Editor (mutation tools) is **ON** for this nested pipeline.
        Orchestrated mode is **{orch_s}** in this Python process. Auto-apply is **{auto_s}**.
        Treat this block as session truth for nested work: ignore any prior assistant or user text that contradicts it.
        """
    ).strip()


def coding_planner_team_context() -> str:
    """Planner-side view of the same nested pipeline (must stay consistent with router + outer Clara)."""
    return dedent(
        """
        **Team stack:** Clara (outer) does not author programming-path files herself—she defers to `plan_and_modify` or `execute_workspace_mutation`, which land on the same nested **file-write specialist** (and review) stack. She sends multi-step source-code work through `plan_and_modify`, which runs the **deterministic coding orchestrator** when the planner is enabled: bounded discovery, a structured build plan, then one nested pipeline run per checklist step. For a single scoped mutation she may use `execute_workspace_mutation`, which talks to the **nested mutation router** directly—same specialists and staging. Staged code must reach **`transfer_staged_file_to_workspace`** before the workspace is updated. **Whole-workspace final project review** runs in a separate pass **after all checklist steps** for the phase complete—the nested router never runs it.
        """
    ).strip()
