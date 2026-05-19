"""Shared prompt fragments injected into Clara's system prompt and tool guidance."""

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
        - `retrieve_workspace_semantic` may return **staging** hits when staging is active; with Editor + Auto-apply (direct writes) hits are workspace-only—verify with `read_workspace_file` / LSP on disk.
        """
    ).strip()


def routing_handoff_contract() -> str:
    """Shared Operation / Paths / Existence rules when scoping a staged edit or review pass."""
    return dedent(
        """
        **Routing handoff** (use when you mentally scope a multi-step edit before calling tools):
        - **Operation:** one of `create` | `update` | `delete` | `dependency` | `review`.
        - **Paths:** canonical workspace-relative path(s); backticks optional. List every path this step touches.
        - **Existence:** one honest line from discovery—e.g. confirmed on disk (file vs directory), new path plus whether the parent directory already exists, or whether a **pending staged draft** exists for that path when that disambiguates create vs update.
        - **Quality bar:** Do not edit until **Existence** is accurate; use targeted `list_workspace_directory` / `read_workspace_file` / LSP checks first.
        """
    ).strip()
