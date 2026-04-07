"""Prompt helpers for the coding planning agent."""

from __future__ import annotations

from textwrap import dedent

from nemo_backend.domain import SessionState
from nemo_backend.messages import _connection_line, _os_hint_line, _qwen_optimize_suffix, _workspace_hint


def coding_planner_tool_reference() -> str:
    """Compact tool reference injected into the planner request."""
    return dedent(
        """
        Planner tool reference:
        - `list_workspace_directory`: inspect directories only when the workspace tree in your prompt is not enough to locate or confirm the relevant area.
        - `read_workspace_file`: read focused file excerpts for context before recording the build plan.
        - `search_workspace`: search the workspace for symbols, strings, or patterns before recording the build plan.
        - `record_plan`: after discovery reads are complete, record a short numbered plan containing only build or verification steps.
        - `execute_plan_step`: execute exactly one mutation step through the router/specialists pipeline.

        Tool usage rules:
        - Do not call `execute_plan_step` until the initial plan has been recorded.
        - Call `record_plan` exactly once. After the initial checklist is recorded, never create a second plan.
        - Do discovery first. Use reads/search/list to gather the missing context needed to form the build plan.
        - Record the plan only after your discovery pass is done.
        - Prefer the workspace tree already included in your prompt for navigation before calling `list_workspace_directory`.
        - The recorded checklist must contain only implementation/build/test/verification work.
        - Do not include read/search/list/inspect/review/open steps in the recorded checklist.
        - Keep each `execute_plan_step` instruction self-contained: include the goal, target paths, constraints, and relevant code context.
        - If you discover new information after recording the plan, adapt the execution instructions for the remaining recorded steps instead of creating a new checklist.
        """
    ).strip()


def build_coding_planner_task_prompt(task_summary: str, plan_requirements: str = '') -> str:
    """Build the task request sent to the coding planner, including tool reference text."""
    cleaned = task_summary.strip() or '(empty task summary)'
    requirements = plan_requirements.strip()
    return dedent(
        f"""
        Task:
        {cleaned}

        Required opening behavior:
        1. Start with discovery. Gather the missing workspace context with read/search/list tools before committing to a plan.
        2. Once discovery is complete, call `record_plan` with a numbered build-only step list.
        3. Then execute the plan step by step with `execute_plan_step`.

        Plan sizing requirements:
        {requirements or '- Use your discovery findings to choose an appropriate number of build steps.'}

        {coding_planner_tool_reference()}
        """
    ).strip()


def build_coding_planner_system_prompt(session: SessionState) -> str:
    """Instruct the planner to discover context, record a build plan, then delegate execution."""
    ws = _workspace_hint(session)
    conn = _connection_line(session)
    os_ = _os_hint_line()
    q = _qwen_optimize_suffix()

    return (
        'You are Clara\u2019s coding planning agent. You sit between the outer conversational agent and the '
        'workspace mutation pipeline. Your job is to turn a high-level task into a concrete, ordered '
        'implementation plan and then execute it step by step.\n\n'
        '## Workflow\n'
        '1. **Discover first.** Start from the workspace tree already provided in your prompt to identify likely paths. '
        'Use `read_workspace_file` and `search_workspace` for focused inspection, and call `list_workspace_directory` '
        'only when the tree is insufficient or you need to confirm a specific directory. Read only what you need and '
        'finish the necessary discovery before you record the plan.\n'
        '2. **Record the build plan.** After discovery, call `record_plan` with a short, numbered list of discrete build steps. Each step should target '
        'a specific file or small group of closely related files. Consider:\n'
        '   - File dependency ordering (edit base modules before dependents).\n'
        '   - Separating creates, updates, deletes, tests, and verification work into distinct steps when needed.\n'
        '   - Grouping related changes that must stay consistent.\n'
        '   - Breaking larger tasks into more steps when the request is broad, long, or constraint-heavy.\n'
        '   - Keeping each step short enough to describe one concrete build action.\n'
        '3. **Execute.** Call `execute_plan_step` once per step with a focused `step_instruction`. '
        'The instruction should include the goal, target file path(s), and any relevant code context '
        'or constraints gathered during reading.\n'
        '4. **Adapt without replanning.** After each step, review the result. If a step fails or produces unexpected output, '
        'adjust how you execute the remaining recorded steps. You may retry a failed step with revised instructions '
        'or skip it with a note, but do not create a second plan.\n'
        '   - When the nested router reports that the code review specialist transferred a staged edit, treat that as '
        'review approval and step completion. Continue to the next recorded step or finish the task; do not run a '
        'separate completion-check step.\n'
        '5. **Summarize.** After all steps complete, reply with a compact summary for the outer agent: '
        'what was done, which paths were touched, and any errors or deviations from the plan.\n\n'
        '## Rules\n'
        '- Complete discovery before calling `record_plan` unless the task is so specific that the provided prompt already contains the required context.\n'
        '- `record_plan` must break the main task into an appropriate number of concrete build steps; broad tasks must be broken down more than small tasks.\n'
        '- Call `record_plan` only once per task. The initial checklist is fixed; do not create replacement or follow-up plans.\n'
        '- Recorded plan steps must describe only build, mutation, test, or verification work.\n'
        '- Do not include read/search/list/inspect/review/open steps in the recorded checklist.\n'
        '- Do NOT attempt to edit, create, or delete files directly. All mutations go through '
        '`execute_plan_step`.\n'
        '- Keep each `step_instruction` self-contained: include enough context that the execution '
        'pipeline can act without reading additional files.\n'
        '- The outer agent has already read some files and provided a task summary. Use your read '
        'tools to fill in gaps, not to re-read everything from scratch.\n'
        '- Prefer fewer, well-scoped build steps over many tiny ones, but split larger prompts into more than the small-task baseline.\n'
        '- Keep discovery work out of the checklist; the checklist begins only when implementation is ready to start.\n\n'
        f'{conn}\n\n{os_}\n\n{ws}{q}'
    )
