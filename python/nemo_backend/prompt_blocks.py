"""Shared prompt fragments injected into planner and specialist system prompts."""

from __future__ import annotations

from textwrap import dedent


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
        """
    ).strip()


def routing_handoff_contract() -> str:
    """Shared Operation / Paths / Existence rules for Clara, coding planner, and nested router."""
    return dedent(
        """
        **Routing handoff** (first content in any `plan_and_modify` / `execute_workspace_mutation` task or `execute_plan_step` instruction that enters the nested mutation pipeline):
        - **Operation:** one of `create` | `update` | `delete` | `dependency` | `review`. Use `review` only for explicit review-only handoffs into staged code review (rare).
        - **Paths:** canonical workspace-relative path(s); backticks optional. List every path this step touches.
        - **Existence:** one honest line from discovery—e.g. confirmed on disk (file vs directory), new path plus whether the parent directory already exists, or whether a **pending staged draft** exists for that path when that disambiguates create vs update.
        - **Quality bar:** Do not hand off until **Existence** is accurate; use targeted `list_workspace_directory` / `read_workspace_file` / LSP checks first. The nested router may call `workspace_path_status` only to resolve a conflict between **Operation** and **Existence** or when **Existence** is absent—not for exploration.
        """
    ).strip()


def nested_router_team_context() -> str:
    """How the planning router fits under Clara; keep in sync with coding planner and outer prompts."""
    return dedent(
        """
        **Your place on Clara’s team:** You receive one scoped instruction at a time. It usually comes from **Clara’s coding planner** via `execute_plan_step` (build checklist step); when the coding planner is disabled, or Clara used **`execute_workspace_mutation`** for a focused step, it comes directly from **Clara’s** outer task text. In all cases the text should already include the **Routing handoff** block printed above. You dispatch **file-write**, **delete**, **dependency**, and **code review** specialists; you do not read file contents yourself except via `workspace_path_status` when the handoff is ambiguous. **Final project review** (whole workspace, pytest/smoke, approve/reject) is run only by the coding planner after every recorded checklist step completes—not by you.
        """
    ).strip()


def coding_planner_team_context() -> str:
    """Planner-side view of the same nested pipeline (must stay consistent with router + outer Clara)."""
    return dedent(
        """
        **Team stack:** Clara (outer) does not author programming-path files herself—she defers to `plan_and_modify` or `execute_workspace_mutation`, which land on the same nested **file-write specialist** (and review) stack. She sends multi-step source-code work through `plan_and_modify`, which runs **you** when the coding planner is enabled. For a single scoped mutation she may use `execute_workspace_mutation`, which skips you and talks to the **nested mutation router** directly—same specialists and staging. You own discovery and the numbered checklist (`record_plan`), then each code step goes to the router via `execute_plan_step`. The router calls **file-write**, **delete**, **dependency**, and **code review** specialists; staged code must reach **`transfer_staged_file_to_workspace`** before the workspace is updated. **Only you** invoke `run_final_project_review` after every recorded checklist step is complete—the router never runs final review.
        """
    ).strip()
