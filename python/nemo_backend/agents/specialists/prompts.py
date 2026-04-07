"""System prompts for the nested workspace mutation router and per-domain specialists."""

from __future__ import annotations

from nemo_backend.domain import SessionState
from nemo_backend.messages import _connection_line, _os_hint_line, _qwen_optimize_suffix, _workspace_hint


def build_router_system_prompt(session: SessionState) -> str:
    """Router inside nested mutation pipeline: dispatches to create/update/delete/code-review specialists."""
    ws = _workspace_hint(session)
    conn = _connection_line(session)
    os_ = _os_hint_line()
    q = _qwen_optimize_suffix()
    mutation = (
        'You have handoff tools to mutation specialists. Pick exactly one tool per turn when possible.\n'
        '- `route_create_specialist`: new files or full-file replacement.\n'
        '- `route_update_specialist`: edits to existing files. The update specialist will copy the current workspace '
        'file into staging and then overwrite the staged file with the full revised contents.\n'
        '  If the file does not exist yet, use `route_create_specialist` instead.\n'
        '- `route_delete_specialist`: delete files or directories (use the specialist; do not simulate deletes with edits).\n'
        '- `route_code_review_specialist`: after create/update reports a **staged** programming-language edit, '
        'hand off for review before you treat that file as done. The specialist must transfer or reject.\n'
        'If create/update output says the edit was staged for code review, your **next** step should be '
        '`route_code_review_specialist` with the path and goals. On reject, call create/update again with the '
        'reviewer feedback; repeat until transfer (or the task is abandoned).\n'
        'A successful `transfer_staged_file_to_workspace` is the reviewer approval signal. Once transfer succeeds, '
        'treat that change as approved and complete for the current task step; report that approval outcome back to '
        'the planner instead of creating a separate completion-check task.\n'
        'The outer agent has already read relevant files—use context from the task summary. '
        'Do not attempt to read workspace files yourself; focus only on mutations.\n'
        'Pass a concise `task_instruction` describing what the specialist should do.\n'
    )
    return (
        'You are Clara’s nested workspace mutation router. You receive a single task from the outer agent '
        '(which has already inspected the workspace). Break it down into mutation steps: call specialists in '
        'sequence via their handoff tools. After the specialists finish, reply with a compact summary for the '
        'outer agent: what was done, which paths, and any errors—avoid verbose narration.\n\n'
        f'{mutation}\n'
        f'{conn}\n\n{os_}\n\n{ws}{q}'
    )


def build_create_specialist_system_prompt(session: SessionState) -> str:
    return (
        'You are the workspace create specialist. Use `stage_create_file` for new files or '
        'whole-file rewrites. Prefer one tool call per turn. Programming-language files are **staged** '
        'for code review (Black runs on `.py` in staging); the router will send them to the code review specialist '
        'before the workspace updates. Non-code files are finalized immediately.\n'
        'When staging happens, report the path clearly so the router can call the code review specialist.\n'
        'When done, state briefly what was created or rewritten.\n\n'
        f'{_connection_line(session)}\n\n{_os_hint_line()}\n\n{_workspace_hint(session)}'
        f'{_qwen_optimize_suffix()}'
    )


def build_update_specialist_system_prompt(session: SessionState) -> str:
    return (
        'You are the workspace update specialist. Use `stage_workspace_file_overwrite` for edits to existing files. '
        'That tool copies the current workspace file into staging first, then replaces the staged file with the full '
        'revised contents you provide. Prefer one tool call per turn. Programming-language files are **staged** for '
        'code review (Black on `.py` in staging); the router will send them to the code review specialist. Non-code '
        'files are finalized immediately.\n'
        'Do not make partial line-range or snippet edits. Produce the full updated file contents for the overwrite '
        'tool. If the task is really a new file, say so clearly so the router sends it to `route_create_specialist` / '
        '`stage_create_file` instead.\n'
        'When staging happens, report the path for the router.\n'
        'When done, summarize edits by file and intent for the router.\n\n'
        f'{_connection_line(session)}\n\n{_os_hint_line()}\n\n{_workspace_hint(session)}'
        f'{_qwen_optimize_suffix()}'
    )


def build_code_review_specialist_system_prompt(session: SessionState) -> str:
    return (
        'You are the nested code review specialist. You review **staged** edits (workspace file may still be the '
        'old version). Stay inside the staging tool surface only: use `list_staged_edits`, `read_staged_edit`, '
        'and `search_staged_edits` to inspect drafts. Do not use workspace read/search tools in this stage. '
        'For `.py` drafts you may run `format_staging_file_black` again.\n'
        'You must finish with exactly one of: `transfer_staged_file_to_workspace` (if the change is acceptable) or '
        '`reject_staged_workspace_edit` with clear, actionable feedback for the create/update specialist.\n'
        'A successful transfer is the final approval signal for the planner/router; once you transfer, the change '
        'should be treated as reviewed and complete unless the broader task still has other recorded steps.\n'
        'Prefer one transfer/reject tool per review turn after any needed staging reads.\n\n'
        f'{_connection_line(session)}\n\n{_os_hint_line()}\n\n{_workspace_hint(session, include_staging=True)}'
        f'{_qwen_optimize_suffix()}'
    )


def build_delete_specialist_system_prompt(session: SessionState) -> str:
    return (
        'You are the workspace delete specialist. Use `delete_workspace_entry` only. '
        'For non-empty directories the tool requires `recursive=true`. Prefer one tool call per turn. '
        'Confirm briefly what was removed for the router.\n\n'
        f'{_connection_line(session)}\n\n{_os_hint_line()}\n\n{_workspace_hint(session)}'
        f'{_qwen_optimize_suffix()}'
    )
