"""Prompt helpers for the coding planning agent.

Live production uses the deterministic orchestrator in ``orchestrator.py`` (discovery subagent → structured
build-plan LLM → ``run_planning_nested_stream`` per step → final project review). Functions below that describe
task/system/reflection text are retained for tests and documentation; they do not reintroduce removed planner tools.
"""

from __future__ import annotations

from textwrap import dedent
from typing import Any

from nemo_backend.domain import SessionState
from nemo_backend.messages import _connection_line, _model_prompt_suffix, _os_hint_line, _workspace_hint
from nemo_backend.prompt_blocks import (
    coding_planner_team_context,
    python_workspace_playbook,
    routing_handoff_contract,
)


def coding_planner_tool_reference(*, include_lsp_discovery: bool = True) -> str:
    """Orchestrator behavior and discovery-tool reference (for tests/docs; not a live single-graph tool list)."""
    lsp_lines = (
        """
        - `lsp_get_diagnostics`: inspect diagnostics through the active LSP session (Python or TS/JS).
        - `lsp_get_document_symbols`: inspect file structure/symbols before planning edits.
        - `lsp_hover`: inspect symbol details at a precise line/character.
        - `lsp_find_definition`: jump from a symbol use to its definition.
        - `lsp_find_references`: inspect symbol references before deciding plan scope.
        """
        if include_lsp_discovery
        else """
        - (LSP tools are not available for this task scope—no programming-language source paths were identified. Prefer `retrieve_workspace_semantic` first, then `search_workspace`, `read_workspace_file`, and `list_workspace_directory`; verify each semantic hit by **origin**—workspace hits with reads/search; staging hits with `read_staged_edit` / diff tools, not `read_workspace_file` alone.)
        """
    )
    return dedent(
        f"""
        Deterministic coding orchestrator (what runs for `plan_and_modify` when the planner is enabled):
        - **Discovery:** a bounded mini-agent uses read/search tools plus optional LSP tools below. For **unknown** targets prefer `retrieve_workspace_semantic` first; for **known** LSP-backed paths (`.py`, `.ts`, …) prefer LSP tools before heavy file reads. It ends with a single assistant message starting with `Discovery complete:`.
        - **Build plan:** a structured LLM call turns the task plus discovery notes into a numbered checklist (build/mutation/verification steps only)—not separate `record_plan` / `execute_plan_step` tools.
        - **Execute:** for each checklist item, the orchestrator composes one nested instruction (routing handoff + context) and runs `run_planning_nested_stream` (nested router → specialists). Staging and **`transfer_staged_file_to_workspace`** apply inside that pipeline.
        - **Final review:** after all steps succeed or loop, the orchestrator runs whole-workspace final project review; on failure it may append a remediation checklist step.

        Discovery-phase tools:
        - `list_workspace_directory`: when the workspace tree in the prompt is not enough to locate the relevant area.
        - `retrieve_workspace_semantic`: semantic recall over workspace and staging; verify each hit by **origin**.
        - `search_workspace` / `read_workspace_file`: gather context before the structured plan is generated.
        - `ensure_python_workspace_env` (outer/session): workspace `.venv` and dependencies when the task needs Python.
        {lsp_lines.strip()}

        **Nested pipeline (per checklist step):** the **file-write specialist** uses staging tools; the **code review specialist** diffs staged vs baseline before transfer; **`transfer_staged_file_to_workspace`** commits approved work.

        **Routing handoff** (Clara should put this first in `plan_and_modify` / `execute_workspace_mutation` task text; the orchestrator embeds it in composed step instructions):
        {routing_handoff_contract()}
        - After the routing handoff lines: goal, constraints, acceptance hints, and the **minimum** context (symbols, snippets, paths) so nested agents do not repeat discovery blindly.
        - For call-chain work, include **callers**, **imports/callees**, and **related paths** so write recon can finish in one pass when possible.

        Rules of thumb:
        - Checklist steps must be build/mutation/test/verification only—no read/search/list meta steps.
        - For Python, add explicit test steps only when justified (user asked, criteria exist, or nearby tests need updates).
        - If a nested step returns `Tool error:` with no workspace transfer, the orchestrator surfaces a retry hint to **outer Clara**—typically **call `plan_and_modify` again** with a narrower task or clearer handoff, not a nonexistent planner tool.
        """
    ).strip()


def build_discovery_system_prompt(
    session: SessionState,
    *,
    include_lsp_discovery: bool = True,
) -> str:
    """Bounded discovery mini-agent: read/search only before structured plan generation."""
    ws = _workspace_hint(session)
    lsp_line = (
        '**LSP-backed source** (`.py`, `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`): when the task already names a '
        'concrete path (or you have one from the tree), your **first** tools on that file should be LSP—start with '
        '`lsp_get_document_symbols`, then `lsp_hover`, `lsp_find_definition`, `lsp_find_references`, `lsp_get_diagnostics` '
        'as needed—**before** relying on semantic chunks or full-file `read_workspace_file`, unless you need literal text '
        'LSP does not surface. For **unknown** targets or repo-wide “where is X?”, prefer `retrieve_workspace_semantic` '
        'first, then switch to LSP-first on each **LSP-supported** candidate path.\n'
        if include_lsp_discovery
        else 'LSP tools are not bound; use `retrieve_workspace_semantic`, `search_workspace`, `read_workspace_file`, '
        '`list_workspace_directory` only—verify semantic hits by **origin** (staging vs on-disk).\n'
    )
    return (
        'You are the **discovery** sub-phase of the coding orchestrator.\n'
        '**Allowed:** workspace reads and navigation (`retrieve_workspace_semantic`, `search_workspace`, '
        '`read_workspace_file`, `list_workspace_directory`)'
        + (
            ', plus LSP read tools (`lsp_get_document_symbols`, `lsp_hover`, `lsp_find_definition`, '
            '`lsp_find_references`, `lsp_get_diagnostics`) for Python/TS/JS source.'
            if include_lsp_discovery
            else '.'
        )
        + ' Semantic recall may include **staging**; verify by **origin** in tool output.\n'
        + lsp_line
        + '**Forbidden in this phase:** staging writes, delegated implementation (nested pipeline), dependency installs, pytest, or summarizing an implementation checklist.\n'
        'Gather the minimum context needed to scope the task. **Do not** draft a numbered implementation checklist, '
        'to-do list, or step-by-step build plan here—that happens in a later phase. When done, send a **single** final '
        'assistant message (no tools) starting with `Discovery complete:` summarizing only facts: relevant paths, '
        'symbols, constraints, and open questions. No re-planning or alternatives after that line.\n\n'
        f'{ws.strip()}'
    )


def build_coding_planner_task_prompt(
    task_summary: str,
    plan_requirements: str = '',
    *,
    include_lsp_discovery: bool = True,
) -> str:
    """Sample task text bundled with orchestrator reference (used in tests; production uses the orchestrator directly)."""
    cleaned = task_summary.strip() or '(empty task summary)'
    requirements = plan_requirements.strip()
    discovery_line = (
        '2. Discovery uses read/search/list/LSP tools to gather context before the structured build plan is generated '
        '(unknown targets: `retrieve_workspace_semantic` first; known LSP paths: LSP tools before heavy reads—verify '
        'every cited path by **origin**: workspace vs staging).'
        if include_lsp_discovery
        else '2. Discovery uses read/search/list tools only (no LSP for this scope) before the structured build plan is generated '
        '(prefer `retrieve_workspace_semantic` first when targets are unknown—verify every cited path by **origin**: workspace vs staging).'
    )
    return dedent(
        f"""
        Task:
        {cleaned}

        Expected pipeline (deterministic orchestrator):
        1. If Python work needs it, ensure `ensure_python_workspace_env` has run on the session/workspace.
        {discovery_line}
        3. A structured LLM emits the numbered build checklist (no separate planner `record_plan` tool).
        4. Each checklist item runs through the nested mutation pipeline (`run_planning_nested_stream`) with a composed instruction that includes the routing handoff.
        5. After all checklist steps complete, the orchestrator runs whole-workspace final project review; remediation steps may be appended on failure.
        6. If a nested step fails with `Tool error:` and nothing transferred to the workspace, outer **Clara** typically retries via a new `plan_and_modify` call with a clearer handoff—there is no `execute_plan_step` tool on the outer agent.

        Plan sizing requirements:
        {requirements or '- Use your discovery findings to choose an appropriate number of build steps.'}

        {python_workspace_playbook()}

        {coding_planner_tool_reference(include_lsp_discovery=include_lsp_discovery)}
        """
    ).strip()


def build_coding_planner_system_prompt(
    session: SessionState,
    *,
    include_lsp_discovery: bool = True,
) -> str:
    """Describe the deterministic orchestrator for tests/docs (not a live single-graph system prompt)."""
    ws = _workspace_hint(session)
    conn = _connection_line(session)
    os_ = _os_hint_line()
    q = _model_prompt_suffix()

    debugger_line = (
        '- **Debugger:** when scoping `plan_and_modify` for Clara, use LSP diagnostics, test output, and minimal reads; '
        'encode a short hypothesis in the task text after the routing block if it helps nested work.\n'
        if include_lsp_discovery
        else '- **Debugger:** when scoping `plan_and_modify` for Clara, use test output and minimal reads; '
        'encode a short hypothesis in the task text after the routing block if it helps nested work.\n'
    )
    discover_first = (
        '1. **Discovery (orchestrator subagent).** Bounded read/search'
        + ('/LSP' if include_lsp_discovery else '')
        + ' pass; ends with `Discovery complete:`. Python `.venv` should exist before LSP-heavy work (`ensure_python_workspace_env`).\n'
    )
    return (
        '## Deterministic coding orchestrator\n'
        'Production `plan_and_modify` with the planner enabled runs **orchestrated code**, not a single agent with '
        '`record_plan` / `execute_plan_step` tools.\n\n'
        '## Role\n'
        '- **Outer Clara** supplies a strong `task_summary` (routing handoff first). She does not implement source changes herself—'
        'nested specialists do, via staging until **`transfer_staged_file_to_workspace`**.\n'
        + debugger_line
        + '- **Systems engineer:** env bootstrap and verification expectations follow the Python workspace playbook below.\n\n'
        f'{coding_planner_team_context()}\n\n'
        '## Workflow\n'
        + discover_first
        + '2. **Structured build plan.** A structured LLM emits numbered build-only steps from the task + discovery notes.\n'
        '3. **Nested execution.** Each step: orchestrator composes an instruction (includes '
        '**Operation** / **Paths** / **Existence**) and runs the nested mutation pipeline once.\n'
        '4. **Retries.** If a nested step errors without workspace transfer, the orchestrator may return guidance to **retry '
        '`plan_and_modify`** with a clearer scope—outer Clara has no `execute_plan_step` tool.\n'
        '5. **Final review.** After **all** checklist steps for the phase, the orchestrator runs whole-workspace final project review; '
        'remediation steps may be appended and re-executed in the nested pipeline.\n'
        '6. **Summarize.** When `plan_and_modify` returns, Clara summarizes for the user in plain language.\n\n'
        f'{python_workspace_playbook()}\n\n'
        '## Rules\n'
        '- Checklist steps are build/mutation/test/verification only.\n'
        '- Prefer targeted `plan_and_modify` task text over vague handoffs; list every path the nested team must touch.\n'
        '- Code-review loops stay inside the nested pipeline—do not reinterpret them as a reason to abandon the outer task.\n\n'
        f'{conn}\n\n{os_}\n\n{ws}{q}'
    )


def build_coding_planner_reflection_prompt(
    *,
    reflection_attempt: int,
    plan_ready: bool,
    steps: list[dict[str, Any]],
    next_step_text: str = '',
    latest_feedback: str = '',
    final_review_state: str = 'pending',
) -> str:
    """Legacy reflection scaffold (tests only); deterministic orchestrator does not use this in production."""
    if not plan_ready:
        return dedent(
            f"""
            Reflection required: you tried to stop before finishing the initial plan setup.

            Before replying, decide what is still missing:
            - Continue discovery if you still lack the context needed to plan.
            - Ensure a structured build checklist can be emitted (orchestrator), then drive nested execution per step.
            - Whole-workspace final review runs only after all checklist steps for the phase complete.

            This is reflection attempt {reflection_attempt}. Do not give a final summary yet unless you are genuinely blocked.
            """
        ).strip()

    if any(str(step.get('state') or '') != 'complete' for step in steps):
        step_lines = '\n'.join(
            f"- [{str(step.get('state') or 'pending').upper()}] {str(step.get('text') or '').strip()}"
            for step in steps
        ).strip()
        if not step_lines:
            step_lines = '- [PENDING] The checklist was recorded but no steps are visible.'
        return dedent(
            f"""
            Reflection required: the recorded checklist still has unfinished work.

            Current checklist:
            {step_lines}

            Original checklist status:
            - The initial build plan is already recorded and locked for this task.
            - Do not replace the checklist mid-phase for reviewer feedback.
            - The orchestrator should run the nested pipeline for the next incomplete step (composed instruction per item).

            Current step to continue:
            - {next_step_text.strip() or '(choose the earliest recorded step that is not complete)'}

            Latest failure or reviewer feedback:
            {latest_feedback.strip() or '(none recorded; inspect the latest tool results already in the conversation)'}

            Review the latest tool results already in the conversation, then choose the next action:
            - Continue the same recorded checklist.
            - If any step shows **[ERROR]** after `Tool error:` from nested work, treat it as **unfinished work**: typically **retry `plan_and_modify`** with a revised routing handoff and narrower scope—outer Clara has no per-step planner tool.
            - If the last attempt failed **without** landing an approved workspace transfer from staging (`transfer_staged_file_to_workspace`), tighten the handoff or scope before retrying—do not skip ahead or finalize unless the step truly required no file change.
            - Each nested instruction must include the routing handoff block (**Operation** / **Paths** / **Existence**), then goal and minimum context.
            - Do not give a final summary yet.
            - Whole-workspace final review runs only after every recorded step is complete.

            This is reflection attempt {reflection_attempt}.
            """
        ).strip()

    step_lines = '\n'.join(
        f"- [{str(step.get('state') or 'pending').upper()}] {str(step.get('text') or '').strip()}"
        for step in steps
    ).strip()
    if not step_lines:
        step_lines = '- [PENDING] The checklist was recorded but no steps are visible.'

    return dedent(
        f"""
        Reflection required: the recorded checklist is complete, but final project review has not succeeded yet.

        Current checklist:
        {step_lines}

        Original checklist status:
        - The initial build plan is already recorded and locked for this task.
        - Whole-workspace final review is orchestrator-driven after all steps complete.

        Current step to continue:
        - {next_step_text.strip() or '(all recorded steps are already complete)'}

        Latest failure or reviewer feedback:
        {latest_feedback.strip() or '(none recorded; inspect the latest tool results already in the conversation)'}

        Review the latest tool results already in the conversation, then choose the next action:
        - Let the orchestrator run final project review; on failure it may append a remediation checklist step executed via the nested pipeline.

        Only give a final summary when final project review succeeds.
        This is reflection attempt {reflection_attempt}.
        """
    ).strip()
