"""Shared prompt fragments injected into Clara's system prompt and tool guidance."""

from __future__ import annotations

from textwrap import dedent

from clara_coder_backend.domain import SessionState
from clara_coder_backend.lsp.file_policy import PRETTIER_MANAGED_SUFFIXES
from clara_coder_backend.session.state import agent_formatters_enabled, runtime_config


def harness_mindset_block() -> str:
    """Nemo harness: confidence framing and tool-error recovery (outer Clara)."""
    return dedent(
        """
        **Harness mindset:** You are a capable coding partner; workspace tools and reads are the source of truth.
        When a tool returns `Tool error:`, treat it as a normal, actionable signal—read it literally, fix one concrete
        mismatch (path or argument shape), refresh anchors if needed, then retry with a smaller step.
        After a successful milestone (e.g. tests passing), briefly confirm the outcome and continue.
        """
    ).strip()


def source_code_formatting_guidance() -> str:
    """Formatter pipeline + I/O defaults so models align with the edit tools before authoring."""
    enc = (runtime_config.tools.default_workspace_encoding or 'utf-8').strip() or 'utf-8'
    nl = (runtime_config.tools.default_workspace_newline or 'lf').strip() or 'lf'
    prettier_exts = ', '.join(sorted(PRETTIER_MANAGED_SUFFIXES))
    if agent_formatters_enabled():
        formatter_bullets = f"""
        - **Automatic formatters** run on every edit before it is written: **Black** on **`.py`**
          (in-memory `format_str`); **Prettier** on **{prettier_exts}** via stdin with `--stdin-filepath <relative-path>`
          so repo config applies (`cwd` = workspace root; CLI from `node_modules/prettier`, global `prettier`, or
          `CLARA_PRETTIER_CLI`; Node from PATH or `CLARA_NODE_EXECUTABLE`). If a formatter is missing or skips, follow the
          **Post-edit checks** footer in tool results.
        - **Other extensions** (e.g. `.go`, `.rs`, `.json`, `.yaml`, `.vue`, …): no harness auto-formatter—match
          indentation (tabs vs spaces), width, quotes, and ordering already visible in reads and LSP excerpts.
        - **Authoring:** mirror neighboring patterns in the same file and repo; keep edits small so Black/Prettier
          produce minimal churn when they run."""
    else:
        formatter_bullets = """
        - **Automatic formatters are off** (Settings → Tools) and `format_workspace_file` is not bound. Match
          indentation (tabs vs spaces), width, quotes, and ordering already visible in reads and LSP excerpts.
        - **Authoring:** mirror neighboring patterns in the same file and repo."""
    return dedent(
        f"""
        **Source formatting & text I/O (apply as soon as you touch source or structured config paths):**
        - **Tool defaults** when `encoding` / `newline` are omitted: **{enc}** and **{nl}** (Settings → Tools). After
          `read_workspace_file`, prefer that file's actual encoding and line endings unless the user
          or task requires a deliberate change.{formatter_bullets}
        """
    ).strip()


def python_workspace_playbook() -> str:
    """Compact Python + workspace habits for coding agents."""
    return dedent(
        """
        Python workspace playbook:
        - Treat the workspace `.venv` as canonical when the session has attached a workspace Python env; avoid assuming a global interpreter.
        - Inspect Python code with LSP tools first when possible: `lsp_get_document_symbols`, then `lsp_find_definition` /
          `lsp_find_references` / `lsp_hover`, then `lsp_get_diagnostics`; use `read_workspace_file` when you need literal text.
        - New files under new folders: use one create/write with the full relative path (e.g. `pkg/sub/mod.py`). Parent directories
          are created by the tools—do not manually mkdir unless the user asked for empty directories.
        - Match the repo’s package layout: add `__init__.py` only when this project already uses explicit packages that way.
        - Before adding parallel helpers (JSON I/O, logging, HTTP, etc.), use `search_workspace` to see whether the repo already exposes a preferred pattern and align with it.
        - `retrieve_workspace_semantic` searches the on-disk workspace index only—verify hits with `read_workspace_file` / LSP on disk.
        """
    ).strip()


def edit_semantics_block() -> str:
    """Canonical workspace edit semantics (write-through edits, per-turn review/reset, Java build rule).

    Injected once via ``messages._outer_agent_operational_block``. Do not re-embed this
    block in model suffixes or tool descriptions—extend this function instead.
    """
    return (
        '**Edit semantics:** `write_workspace_file`, `replace_workspace_lines` and `replace_workspace_snippet` '
        '(when bound) write the workspace file **immediately**—there is no staging, approval, or landing step, '
        'and no diff card. After your reply the user reviews every file this turn touched and may reset any of '
        'them, so finish the edits the task needs and summarize what changed per file. A note that the user reset '
        'a file means it is back to its pre-turn content: re-read it before editing it again. '
        'Prefer `replace_workspace_lines` when a numbered read gave you line numbers and `replace_workspace_snippet` '
        'for unique raw context; use `write_workspace_file` for new files or a genuine whole-file rewrite, after '
        'reading the existing file whole so headers and imports survive. Line numbers and anchors go stale after '
        'each edit—re-read before a partial edit of the same file in a later response. Parallel edits in one '
        'response may all use the same read: non-overlapping line ranges are shifted for each other. '
        '**Java builds:** before creating `.java` files in a folder where neither it nor any parent up to the '
        'workspace root has `pom.xml`, `build.gradle(.kts)` or `settings.gradle(.kts)`, call '
        '`java_bootstrap_project` (ask the user Gradle or Maven when nothing hints at one). Never hard-code jar '
        'paths (e.g. into `~/.gradle/caches` or `~/.m2/repository`)—declare dependencies as '
        '`group:artifact:version`.'
    )


def subagent_role_block(name: str) -> str:
    """Role of a sub-agent session (one-shot clone the main agent started with ``spawn_subagent``)."""
    label = ' '.join((name or '').split()) or 'sub-agent'
    return dedent(
        f"""
        **You are a sub-agent** named `{label}`, working for the main Clara agent, not directly for the user.
        - The task in the first message comes from the main agent. Do that task with your tools; do not
          widen it, and stay within the files it names when it says so.
        - You cannot ask the user (or the main agent) anything: when something is unclear, make a sensible
          choice and say so. You get no follow-ups: this turn is your whole job.
        - Your final message is your report back to the main agent: concise, with what you found or
          changed (paths, key facts, anything left undone). It is not shown to the user as a reply.
        """
    ).strip()


def routing_handoff_contract() -> str:
    """Shared Operation / Paths / Existence rules when scoping an edit."""
    return dedent(
        """
        **Routing handoff** (use when you mentally scope a multi-step edit before calling tools):
        - **Operation:** one of `create` | `update` | `delete` | `dependency` | `review`.
        - **Paths:** canonical workspace-relative path(s); backticks optional. List every path this step touches.
        - **Existence:** one honest line from discovery—e.g. confirmed on disk (file vs directory), or a new path plus whether the parent directory already exists.
        - **Quality bar:** Do not edit until **Existence** is accurate; use targeted `list_workspace_directory` / `read_workspace_file` / LSP checks first.
        """
    ).strip()


def speech_tts_mood_block() -> str:
    """When speech/TTS is on: model must emit a strip-able mood tag for the voice pipeline."""
    return dedent(
        """
        **Spoken reply (TTS is on):** The user's client will read your reply aloud.
        - Start the user-facing reply with exactly one mood line the UI strips before speech:
          `[[tts_mood: short natural-language mood and tone]]`
          Example: `[[tts_mood: calm, helpful, slightly upbeat]]`
        - Keep the mood phrase short (a few adjectives or a brief speaking style). Do not put the mood only inside the spoken prose.
        - After the tag, write normally. Prefer concise spoken-friendly sentences; avoid dumping large code blocks when a short summary suffices.
        """
    ).strip()
