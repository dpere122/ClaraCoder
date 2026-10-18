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
        mismatch (path, argument shape, workspace vs staging), refresh anchors if needed, then retry with a smaller step.
        After a successful milestone (transfer, nested run, or tests passing), briefly confirm the outcome and continue.
        """
    ).strip()


def source_code_formatting_guidance() -> str:
    """Formatter pipeline + I/O defaults so models align with staging tools before authoring."""
    enc = (runtime_config.tools.default_workspace_encoding or 'utf-8').strip() or 'utf-8'
    nl = (runtime_config.tools.default_workspace_newline or 'lf').strip() or 'lf'
    prettier_exts = ', '.join(sorted(PRETTIER_MANAGED_SUFFIXES))
    if agent_formatters_enabled():
        formatter_bullets = f"""
        - **Automatic formatters** run on merged staged content before diff/LSP review: **Black** on **`.py`**
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
        - **Automatic formatters and format tools are off** (Settings → Tools). Do not call `format_staging_file_black`,
          `format_staging_file_prettier`, `format_workspace_file_black`, or `format_workspace_file_prettier`. Match
          indentation (tabs vs spaces), width, quotes, and ordering already visible in reads and LSP excerpts.
        - **Authoring:** mirror neighboring patterns in the same file and repo."""
    return dedent(
        f"""
        **Source formatting & text I/O (apply as soon as you touch source or structured config paths):**
        - **Tool defaults** when `encoding` / `newline` are omitted: **{enc}** and **{nl}** (Settings → Tools). After
          `read_workspace_file` / `read_staged_edit`, prefer that file's actual encoding and line endings unless the user
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
        - `retrieve_workspace_semantic` searches the on-disk workspace index only—verify hits with `read_workspace_file` / LSP on disk; use `search_staged_edits` for pending drafts.
        """
    ).strip()


def edit_semantics_block(direct: bool) -> str:
    """Canonical workspace edit semantics: LSP-mutator map + landing / draft policy.

    Injected once via ``messages._outer_agent_operational_block``. Do not re-embed this
    block in model suffixes—extend this function instead.
    ``direct=True`` describes the Auto-apply on-disk path; ``direct=False`` describes the
    staging/LSP staging path with the ``land_in_workspace`` policy.
    """
    lsp_map = (
        '`.py` → `lsp_create_python_file` / `lsp_update_python_file` / `lsp_delete_python_file`; '
        '`.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs` → `lsp_create_typescript_file` / `lsp_update_typescript_file` / `lsp_delete_typescript_file`; '
        '`.gd` → `lsp_create_gdscript_file` / `lsp_update_gdscript_file` / `lsp_delete_gdscript_file`; '
        '`.java` → `lsp_create_java_file` / `lsp_update_java_file` / `lsp_delete_java_file`'
    )
    java_build_rule = (
        '**Java builds:** before creating `.java` files in a folder where neither it nor any parent up to the '
        'workspace root has `pom.xml`, `build.gradle(.kts)` or `settings.gradle(.kts)`, call '
        '`java_bootstrap_project` (ask the user Gradle or Maven when nothing hints at one). Never hard-code jar '
        'paths (e.g. into `~/.gradle/caches` or `~/.m2/repository`) in build scripts or build files—declare '
        'dependencies as `group:artifact:version` so the build tool resolves them.'
    )
    if direct:
        return (
            '**Edit semantics (direct):** Editor and Auto-apply are on—write directly to disk with '
            '`apply_workspace_full_file`, `replace_workspace_line_range`, or `replace_workspace_snippet` '
            '(when bound) for text edits. Prefer language-matched LSP mutators when bound: '
            f'{lsp_map}. {java_build_rule} Writes land on disk immediately—there is no staging draft plane and no '
            '`transfer_staged_file_to_workspace` on your graph.'
        )
    return (
        '**Edit semantics (staging):** Use `stage_create_file`, `stage_workspace_file_overwrite`, '
        '`stage_line_range_edit`, and `stage_snippet_edit` (when bound) to create or revise any text path; '
        'inspect drafts with `list_staged_edits` / `diff_staged_edit_against_baseline` / `read_staged_edit`. '
        '**Write-through:** `stage_*` writes the real workspace file immediately and journals the pre-stage bytes. '
        '`read_workspace_file` and `read_staged_edit` show the same current text. '
        '`transfer_staged_file_to_workspace` keeps the write (drops the journal); `discard_staged_edits` restores '
        'the journal. After staging a path, refresh anchors from `read_workspace_file` or `read_staged_edit` '
        'before the next partial edit on that same path. '
        'Before calling `stage_workspace_file_overwrite` or `stage_create_file` on an **existing** file with no prior '
        'pending journal, first call `read_workspace_file` **without** `start_line`/`end_line` to capture the whole file '
        'so headers, footers, and imports are preserved (if a journal already exists for the path, '
        'read the current on-disk draft so the overwrite starts from that text). '
        'Prefer `stage_line_range_edit` when you already know line numbers from a numbered read; reserve '
        '`stage_snippet_edit` for unique multi-line raw context copied with `include_line_numbers=false`. '
        'Prefer those targeted tools over `stage_workspace_file_overwrite` except when the entire file\u2019s '
        'purpose or fundamental structure is being completely replaced (e.g. full rewrite, format conversion, '
        'scaffolding a new layout). Targeted edits via line-range/snippet stages produce smaller, reviewable '
        'diffs and avoid clobbering unrelated regions. '
        'You may also use language-matched LSP mutators when they appear in your bound tool list: '
        f'{lsp_map} (same staging/review path); if they are not on your graph, use `stage_*` instead. '
        f'{java_build_rule} '
        'If a `stage_*` call returns a write id (still running), call `wait_for_write` or `cancel_write` — '
        'do not start another write for that path. '
        'When drafts should stay, pass `land_in_workspace=true` on your final `stage_*` or LSP create/update '
        'call to keep in one step (HITL keep-vs-restore when auto-apply is off; stop after the tool returns when '
        'auto-apply is off). Keep `land_in_workspace=false` (default) while iterating or before review '
        'completes. For drafts already written without a keep, call `transfer_staged_file_to_workspace` with '
        '`relative_paths` (batch when multiple files are ready). '
        'To abandon a pending draft and restore the journal (including after user re-review), call `discard_staged_edits`. '
        'Never ask the user to apply or approve landing for you—only the tool call counts. '
        'Do not use legacy direct-to-disk workspace mutators '
        '(`apply_workspace_full_file`, `replace_workspace_*`) on agent graphs—they are not the primary path.'
    )


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
