"""Prompt helpers for the coding planning agent."""

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
    """Compact tool reference injected into the planner request."""
    lsp_lines = (
        """
        - `lsp_get_diagnostics`: inspect Python diagnostics through the active LSP session.
        - `lsp_get_document_symbols`: inspect Python file structure before planning edits.
        - `lsp_hover`: inspect Python symbol details at a precise line/character.
        - `lsp_find_definition`: jump from a Python symbol use to its definition.
        - `lsp_find_references`: inspect Python symbol references before deciding plan scope.
        """
        if include_lsp_discovery
        else """
        - (LSP tools are not available for this task scope—no programming-language source paths were identified. Use `read_workspace_file`, `list_workspace_directory`, and `search_workspace` for discovery.)
        """
    )
    return dedent(
        f"""
        Planner tool reference:
        - `list_workspace_directory`: inspect directories only when the workspace tree in your prompt is not enough to locate or confirm the relevant area.
        - `read_workspace_file`: read focused non-code or config file excerpts for context before recording the build plan.
        - `search_workspace`: search the workspace for symbols, strings, or patterns before recording the build plan.
        - `ensure_python_workspace_env`: create or reuse the workspace `.venv`, install workspace dependencies, install Python LSP support, and activate it for this session.
        {lsp_lines.strip()}
        - `record_plan`: after discovery reads are complete, record a short numbered plan containing only build or verification steps. When `run_final_project_review` fails, the tool appends a remediation step automatically—run `execute_plan_step` for it (call `record_plan` only if you must split remediation into multiple steps). After `run_final_project_review` succeeds, you may call `record_plan` again to start a new implementation phase if more build work is required.
        - `apply_workspace_full_file`, `replace_workspace_line_range`, `replace_workspace_snippet` (when available): direct workspace edits **only for non-code paths** (not .py, .ts, .js, or other code-review extensions). Use these for steps that touch markdown, json, yaml, plain text config, etc. Code paths must use `execute_plan_step` / nested staging.
        - `execute_plan_step`: execute exactly one **code-related** mutation step through the nested mutation router and specialists (write/delete/dependency/code review as needed). Inside that step, the **file-write specialist** runs discover-then-stage (search/list/read, then staging tools). The **code review specialist** reviews using a mechanical **`diff_staged_edit_against_baseline`** (git-style unified diff: workspace snapshot at stage time vs staged draft) before relying on full-file reads; on approval it calls **`transfer_staged_file_to_workspace` once per pending path**, so multi-file steps need one transfer per file.
        - `run_final_project_review`: after every recorded build step is complete (and nested code review has transferred for the last code step), run the final project reviewer directly. That reviewer owns workspace-level verification (pytest when justified, smoke runs, diagnostics) and the final pass/fail decision—not the nested router.

        Routing handoff block (required at the start of every `execute_plan_step` `step_instruction`; same contract Clara uses in `plan_and_modify` / `execute_workspace_mutation`):
        {routing_handoff_contract()}
        - After the routing handoff lines, add: concrete goal, constraints, acceptance hints, and the **minimum** code context (symbols, snippets, or file excerpts) the router and specialists need—do not make them re-run your discovery.

        Tool usage rules:
        - Do not call `execute_plan_step` until the plan has been recorded for the current phase.
        - Call `record_plan` once per implementation phase. After a checklist is recorded, keep executing it until final review; do not replace that checklist mid-phase. After final project review succeeds, call `record_plan` again when another build phase is needed.
        - For Python workspaces, ensure the workspace Python environment is ready before planning. If no active `.venv` is available yet, call `ensure_python_workspace_env` first.
        - Do discovery first. Use reads/search/list{'/LSP' if include_lsp_discovery else ''} tools to gather the missing context needed to form the build plan.
        - Record the plan only after your discovery pass is done.
        - After the plan is recorded, you may do a small targeted read/search/list follow-up only when a failed or blocked step needs more context. Do not restart broad discovery.
        - Prefer the workspace tree already included in your prompt for navigation before calling `list_workspace_directory`.
        - {'When the task touches Python code, prefer the LSP-directed tools for inspection and navigation. Use `read_workspace_file` only when you truly need the literal file text.' if include_lsp_discovery else 'Use `read_workspace_file`, `list_workspace_directory`, and `search_workspace` for discovery; LSP tools are not bound for this task scope.'}
        - The recorded checklist must contain only implementation/build/test/verification work.
        - When the task touches Python code, add a test-focused step only when the user asked for tests, concrete test criteria already exist, or nearby workspace tests clearly need updates. Otherwise prefer runtime verification over inventing tests.
        - Do not include read/search/list/inspect/review/open steps in the recorded checklist.
        - Keep each `execute_plan_step` instruction self-contained: start with the routing handoff block (**Operation** / **Paths** / **Existence**), then the goal, constraints, and relevant code context so the nested router can choose the right specialist without guessing.
        - For checklist steps that only change non-code files, use the direct workspace edit tools instead of `execute_plan_step`; do not send non-code write work into the nested write specialist.
        - If you discover new information after recording the plan, adapt the execution instructions for the remaining recorded steps instead of replacing the checklist mid-phase (before final review completes).
        - If code review rejects a staged edit or requests changes, the nested reviewer and implementation specialists will handle that revision loop. Do not create a new plan for reviewer feedback.
        - If final project review fails, `run_final_project_review` appends a remediation step—execute it with `execute_plan_step`, then `run_final_project_review` again when the checklist is complete.
        - Do not give a final summary until `run_final_project_review` succeeds or explicitly hands control back for a new planner graph.
        """
    ).strip()


def build_coding_planner_task_prompt(
    task_summary: str,
    plan_requirements: str = '',
    *,
    include_lsp_discovery: bool = True,
) -> str:
    """Build the task request sent to the coding planner, including tool reference text."""
    cleaned = task_summary.strip() or '(empty task summary)'
    requirements = plan_requirements.strip()
    discovery_line = (
        '2. Start with discovery. Gather the missing workspace context with read/search/list/LSP tools before committing to a plan.'
        if include_lsp_discovery
        else '2. Start with discovery. Gather the missing workspace context with read/search/list tools only (LSP tools are not available for this task scope) before committing to a plan.'
    )
    return dedent(
        f"""
        Task:
        {cleaned}

        Required opening behavior:
        1. If this is a Python workspace and the workspace `.venv` is missing or inactive, initialize it first with `ensure_python_workspace_env`.
        {discovery_line}
        3. Once discovery is complete, call `record_plan` with a numbered build-only step list.
        4. Then execute the plan step by step with `execute_plan_step`, each time passing a `step_instruction` that begins with the routing handoff block (**Operation** / **Paths** / **Existence**) as in the tool reference.
        5. After every recorded step is complete, call `run_final_project_review` (only you—not the nested router—run final review).
        6. If execution stalls before final review, keep working on the same recorded plan without replacing the checklist.
        7. If code review rejects a change, treat that as an implementation-layer loop between reviewer and writer. Do not replace the checklist for reviewer feedback mid-phase.
        8. If final project review fails, a remediation step is appended automatically—run `execute_plan_step` for it, then `run_final_project_review` again when every step is complete.
        9. If final project review succeeds and the user task (or clear follow-on work) still needs more implementation, call `record_plan` again for the next phase, then `execute_plan_step` and `run_final_project_review` as usual.

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
    """Instruct the planner to discover context, record a build plan, then delegate execution."""
    ws = _workspace_hint(session)
    conn = _connection_line(session)
    os_ = _os_hint_line()
    q = _model_prompt_suffix()

    debugger_line = (
        '- **Debugger:** use LSP diagnostics, test or reviewer output, and minimal targeted reads to localize failures; '
        'when it helps the mutation pipeline, add a short hypothesis to the `step_instruction` after the routing block.\n'
        if include_lsp_discovery
        else '- **Debugger:** use test or reviewer output and minimal targeted reads to localize failures; '
        'when it helps the mutation pipeline, add a short hypothesis to the `step_instruction` after the routing block.\n'
    )
    discover_first = (
        '1. **Discover first.** Start from the workspace tree already provided in your prompt to identify likely paths. '
        'If the workspace contains Python code and no active workspace `.venv` is available yet, initialize it with '
        '`ensure_python_workspace_env` before relying on LSP or planning implementation steps. '
        'For Python code, prefer `lsp_get_document_symbols`, `lsp_hover`, `lsp_find_definition`, '
        '`lsp_find_references`, and `lsp_get_diagnostics` for focused inspection and navigation. Use '
        '`read_workspace_file` when you need literal file text, and call `list_workspace_directory` only when the tree '
        'is insufficient or you need to confirm a specific directory. Read only what you need and finish the necessary '
        'discovery before you record the plan.\n'
        if include_lsp_discovery
        else '1. **Discover first.** Start from the workspace tree already provided in your prompt to identify likely paths. '
        'If the workspace contains Python code and no active workspace `.venv` is available yet, initialize it with '
        '`ensure_python_workspace_env` before planning implementation steps. '
        'LSP tools are not bound for this task scope—use `read_workspace_file`, `list_workspace_directory`, and '
        '`search_workspace` for discovery. Read only what you need and finish the necessary discovery before you record the plan.\n'
    )
    return (
        'You are Clara\u2019s coding planning agent. You sit between the outer conversational agent and the '
        'workspace mutation pipeline. Your job is to turn a high-level task into a concrete, ordered '
        'implementation plan and then execute it step by step.\n\n'
        '## Role\n'
        '- **Coordinator (not the implementer):** you never type source code into files yourself. Every programming-path '
        'mutation goes through `execute_plan_step` → nested router → **file-write specialist** (same specialist Clara '
        'reaches via `plan_and_modify` / `execute_workspace_mutation`). Prefer surgical, well-scoped step instructions '
        'and preserve invariants in what you ask the pipeline to do.\n'
        + debugger_line
        + '- **Systems engineer:** treat env bootstrap, dependencies, manifests, and verification (pytest vs smoke vs repair) '
        'using the Python workspace playbook below—do not duplicate it with long prose.\n\n'
        f'{coding_planner_team_context()}\n\n'
        '## Workflow\n'
        + discover_first
        + '2. **Record the build plan.** After discovery, call `record_plan` with a short, numbered list of discrete build steps. Each step should target '
        'a specific file or small group of closely related files. Consider:\n'
        '   - File dependency ordering (edit base modules before dependents).\n'
        '   - Separating creates, updates, deletes, tests, and verification work into distinct steps when needed.\n'
        '   - For Python work, adding a final test step only when the user asked for tests, concrete test criteria exist, or nearby workspace tests need updating. Otherwise prefer verification/smoke-run work over inventing tests.\n'
        '   - Grouping related changes that must stay consistent.\n'
        '   - Breaking larger tasks into more steps when the request is broad, long, or constraint-heavy.\n'
        '   - Keeping each step short enough to describe one concrete build action.\n'
        '3. **Execute.** For each recorded step: if it only touches **non-code** paths, use the direct workspace edit '
        'tools; if it touches **code-review** paths, call `execute_plan_step` with a focused `step_instruction` that '
        'starts with the routing handoff block (**Operation:** / **Paths:** / **Existence:**) so the nested router can '
        'dispatch correctly. Add goal, paths, and code context as needed. Nested code paths use discover-then-stage on '
        'the write specialist, diff-first review (`diff_staged_edit_against_baseline`), and **per-file** '
        '`transfer_staged_file_to_workspace` for each staged path in the step.\n'
        '4. **Adapt without mid-phase replanning.** After each step, review the result. If a step fails or produces unexpected output, '
        'adjust how you execute the remaining recorded steps. You may retry a failed step with revised instructions '
        'or gather a small amount of additional workspace context to unblock it, but do not replace the checklist '
        'while final review for this phase is still pending.\n'
        '   - If code review rejects a staged edit, treat that as an implementation-layer retry loop inside the nested '
        'writer/reviewer graph, not as a reason to replace the checklist mid-phase.\n'
        '   - When the nested router reports that the code review specialist transferred a staged edit, treat that as '
        'review approval and step completion. Continue to the next recorded step or finish the task; do not run a '
        'separate completion-check step.\n'
        '5. **Final review.** After all recorded steps complete (including any code-review transfer for the last step), '
        'call `run_final_project_review` yourself. The nested router never runs final project review. Do not give the outer '
        'summary until that tool succeeds.\n'
        '6. **More work after a passed review.** When final project review succeeds and more implementation is still '
        'required, call `record_plan` again for the next phase, execute those steps, and run final review again.\n'
        '7. **Summarize.** When the task is fully done (including any extra phases you recorded after a passed review), '
        'reply with a compact summary for **Clara** (outer): what was done, which paths were touched, and any errors '
        'or deviations from the plan.\n\n'
        f'{python_workspace_playbook()}\n\n'
        '## Rules\n'
        '- Complete discovery before calling `record_plan` unless the task is so specific that the provided prompt already contains the required context.\n'
        '- For Python workspaces, do not start the plan until the workspace Python environment has been initialized and dependency installation has run.\n'
        '- `record_plan` must break the main task into an appropriate number of concrete build steps; broad tasks must be broken down more than small tasks.\n'
        '- Call `record_plan` once per implementation phase. The checklist for the current phase is fixed until final '
        'project review completes; do not replace it mid-phase. After final review succeeds, call `record_plan` again '
        'when another build phase is needed.\n'
        '- Recorded plan steps must describe only build, mutation, test, or verification work.\n'
        '- When the task touches Python code, add a test-focused checklist step only when the user asked for tests, concrete test criteria exist, or nearby workspace tests clearly need updates. Otherwise prefer runtime verification over inventing tests.\n'
        '- Do not include read/search/list/inspect/review/open steps in the recorded checklist.\n'
        '- After the checklist is recorded, additional read/search/list calls are allowed only as a narrow follow-up to unblock the current recorded step.\n'
        '- **Code-review path** mutations go through `execute_plan_step` only. **Non-code** path mutations use '
        '`apply_workspace_full_file` / `replace_workspace_line_range` / `replace_workspace_snippet` (when available); '
        'do not send non-code writes through `execute_plan_step`.\n'
        '- Keep each `step_instruction` self-contained: begin with **Operation** / **Paths** / **Existence**, then include '
        'enough context that the execution pipeline can act without reading additional files. If **Existence** is unknown, '
        'discover it before executing that step.\n'
        '- If a reviewer requests changes, keep the fix scoped to the current recorded step and the affected path(s). '
        'Do not broaden the task or invent new cleanup work; do not call `record_plan` again mid-phase for reviewer feedback.\n'
        '- Code-review rejection belongs to the nested writer/reviewer loop. Do not respond to code-review feedback by replacing the checklist mid-phase.\n'
        '- If final project review fails, `run_final_project_review` appends a remediation step—execute it, then run final review again.\n'
        '- After the recorded checklist is complete, you must call `run_final_project_review` before summarizing that phase. '
        'If you record another phase after a passed review, run final review again after that phase.\n'
        '- Clara (outer) may have read some files in the `plan_and_modify` task summary. Use your read '
        'tools to fill in gaps, not to re-read everything from scratch.\n'
        '- Prefer fewer, well-scoped build steps over many tiny ones, but split larger prompts into more than the small-task baseline.\n'
        '- Keep discovery work out of the checklist; the checklist begins only when implementation is ready to start.\n\n'
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
    """Prompt the planner to reflect and continue when it stops early."""
    if not plan_ready:
        return dedent(
            f"""
            Reflection required: you tried to stop before finishing the initial plan setup.

            Before replying, decide what is still missing:
            - Continue discovery if you still lack the context needed to plan.
            - Call `record_plan` once you have enough context.
            - Once every recorded step is complete, call `run_final_project_review` instead of stopping early.

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
            - Do not call `record_plan` again.
            - Your next tool call should usually be `execute_plan_step` for the next incomplete step.

            Current step to continue:
            - {next_step_text.strip() or '(choose the earliest recorded step that is not complete)'}

            Latest failure or reviewer feedback:
            {latest_feedback.strip() or '(none recorded; inspect the latest tool results already in the conversation)'}

            Review the latest tool results already in the conversation, then choose the next action:
            - Continue the same recorded checklist.
            - Call `execute_plan_step` for the next incomplete step, or gather only the minimum extra context needed to unblock it.
            - Each `step_instruction` must begin with the routing handoff block (**Operation** / **Paths** / **Existence**), then goal, constraints, and the minimum code context the nested team needs.
            - Do not call `record_plan` again.
            - Do not give a final summary yet.
            - Call `run_final_project_review` only after every recorded step is complete.

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
        - Do not call `record_plan` again while you still have incomplete recorded steps.
        - Your next tool call should be `run_final_project_review`.

        Current step to continue:
        - {next_step_text.strip() or '(all recorded steps are already complete)'}

        Latest failure or reviewer feedback:
        {latest_feedback.strip() or '(none recorded; inspect the latest tool results already in the conversation)'}

        Review the latest tool results already in the conversation, then choose the next action:
        - Call `run_final_project_review` now.
        - If final review fails, a remediation step is appended automatically—run `execute_plan_step` for it.

        Only give a final summary when final project review succeeds.
        This is reflection attempt {reflection_attempt}.
        """
    ).strip()
