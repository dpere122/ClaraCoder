"""Build plan Markdown persistence under ``.nemo/build-plans/``."""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from nemo_backend.domain import SessionState

BUILD_PLANS_REL_DIR = '.nemo/build-plans'
MAX_BUILD_PLANS = 5
INDEX_FILENAME = 'index.json'

STEP_ID_COMMENT_RE = re.compile(r'<!--\s*step-id:\s*(\S+)\s*-->')
CHECKBOX_LINE_RE = re.compile(r'^- \[( |x|X)\] (.*)$')
BUILD_PLAN_TITLE_RE = re.compile(r'^#\s*Build\s+Plan:\s*(.+)$', re.IGNORECASE)
SECTION_HEADER_RE = re.compile(r'^##\s+(.+)$')

BUILD_PLAN_DRAFT_STUB = '# Build Plan\n\n_Generating plan…_\n'


class OpenQuestion(BaseModel):
    """A clarifying question the planner surfaces to the user before execution."""

    id: str = Field(description='Stable id like q-1.')
    prompt: str = Field(description='The question to ask the user.')
    options: list[str] = Field(
        default_factory=list,
        description='Suggested answers the user can pick. The UI always appends an "Other" free-text choice.',
    )


class ActionStep(BaseModel):
    """One enriched, verifiable milestone in a build plan."""

    id: str = Field(description='Stable id like step-1.')
    goal: str = Field(description='The milestone outcome in one line (renders on the checkbox).')
    files_touched: list[str] = Field(
        default_factory=list,
        description='Workspace-relative paths this step modifies.',
    )
    approach: str = Field(default='', description='Brief description of how to implement the step.')
    acceptance_criteria: list[str] = Field(
        default_factory=list,
        description='Checkable outcomes that prove the step is done.',
    )
    verification: str = Field(
        default='',
        description='Command or check to run to verify the step (e.g. `pytest tests/x`).',
    )
    risks: list[str] = Field(default_factory=list, description='Risks or caveats for this step.')


class BuildPlanModel(BaseModel):
    """Structured planner output for a build plan document."""

    title: str = Field(description='Short title for the build plan.')
    task: str = Field(description='What the user asked for and the objective.')
    current_implementation: str = Field(
        description='How the codebase currently handles this area (facts from discovery).',
    )
    files_to_change: list[str] = Field(
        default_factory=list,
        description='Workspace-relative paths with brief rationale, e.g. "src/foo.ts — add handler".',
    )
    assumptions: list[str] = Field(
        default_factory=list,
        description='Assumptions the planner made that the user should be aware of.',
    )
    open_questions: list[OpenQuestion] = Field(
        default_factory=list,
        description='Clarifying questions to ask the user before execution.',
    )
    rollback_notes: str = Field(default='', description='How to roll back the changes if needed.')
    definition_of_done: list[str] = Field(
        default_factory=list,
        description='Plan-level outcomes that prove the whole objective is met.',
    )
    action_steps: list[ActionStep] = Field(
        default_factory=list,
        description='Ordered, verifiable milestone steps the executor should accomplish.',
    )


@dataclass
class BuildPlanRecord:
    id: str
    relative_path: str
    session_id: str
    title: str
    created_at: str
    status: str
    conversation_title: str = ''


def _build_plans_root(workspace_root: str | Path) -> Path:
    return Path(workspace_root).resolve() / '.nemo' / 'build-plans'


def _index_path(workspace_root: str | Path) -> Path:
    return _build_plans_root(workspace_root) / INDEX_FILENAME


def _load_index(workspace_root: str | Path) -> list[dict[str, Any]]:
    path = _index_path(workspace_root)
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return []
    if isinstance(data, list):
        return [entry for entry in data if isinstance(entry, dict)]
    return []


def _save_index(workspace_root: str | Path, entries: list[dict[str, Any]]) -> None:
    root = _build_plans_root(workspace_root)
    root.mkdir(parents=True, exist_ok=True)
    _index_path(workspace_root).write_text(
        json.dumps(entries, indent=2, ensure_ascii=False) + '\n',
        encoding='utf-8',
    )


def _entry_to_record(entry: dict[str, Any]) -> BuildPlanRecord:
    return BuildPlanRecord(
        id=str(entry.get('id') or ''),
        relative_path=str(entry.get('relativePath') or '').replace('\\', '/'),
        session_id=str(entry.get('sessionId') or ''),
        title=str(entry.get('title') or ''),
        created_at=str(entry.get('createdAt') or ''),
        status=str(entry.get('status') or 'active'),
        conversation_title=str(entry.get('conversationTitle') or ''),
    )


def _md_path(workspace_root: str | Path, relative_path: str) -> Path:
    return Path(workspace_root).resolve() / relative_path.replace('\\', '/')


def _delete_entry_files(workspace_root: str | Path, entry: dict[str, Any]) -> None:
    rel = str(entry.get('relativePath') or '').replace('\\', '/')
    if not rel:
        return
    md_path = _md_path(workspace_root, rel)
    if md_path.is_file():
        md_path.unlink()


def _evict_if_needed(workspace_root: str | Path, entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = list(entries)
    while len(out) >= MAX_BUILD_PLANS:
        finished = [e for e in out if str(e.get('status') or '') in ('complete', 'cancelled')]
        if finished:
            finished.sort(key=lambda e: str(e.get('createdAt') or ''))
            victim = finished[0]
        else:
            out.sort(key=lambda e: str(e.get('createdAt') or ''))
            victim = out[0]
        _delete_entry_files(workspace_root, victim)
        out.remove(victim)
    return out


def _render_action_step(step: ActionStep, step_num: int) -> list[str]:
    """Render one enriched action step as markdown lines (checkbox + nested details)."""
    step_id = f'step-{step_num}'
    lines = [f'<!-- step-id: {step_id} -->']
    goal = step.goal.strip() or '(no goal)'
    lines.append(f'- [ ] {goal}')
    if step.files_touched:
        lines.append(f'  - **Files:** {", ".join(step.files_touched)}')
    if step.approach.strip():
        lines.append(f'  - **Approach:** {step.approach.strip()}')
    if step.acceptance_criteria:
        lines.append('  - **Acceptance criteria:**')
        lines.extend(f'    - {item.strip()}' for item in step.acceptance_criteria if item.strip())
    if step.verification.strip():
        lines.append(f'  - **Verification:** {step.verification.strip()}')
    if step.risks:
        lines.append('  - **Risks:**')
        lines.extend(f'    - {item.strip()}' for item in step.risks if item.strip())
    return lines


def render_build_plan_md(doc: Any) -> str:
    """Render planner output into the build-plan Markdown template."""

    lines = [
        f'# Build Plan: {doc.title.strip()}',
        '',
        '## Task',
        doc.task.strip(),
        '',
        '## Current Implementation',
        doc.current_implementation.strip(),
        '',
        '## Files to Change',
    ]
    file_rows = [str(item).strip() for item in (doc.files_to_change or []) if str(item).strip()]
    if file_rows:
        lines.extend(f'- {row}' for row in file_rows)
    else:
        lines.append('- (none specified)')

    assumptions = [str(a).strip() for a in (doc.assumptions or []) if str(a).strip()]
    if assumptions:
        lines.extend(['', '## Assumptions'])
        lines.extend(f'- {a}' for a in assumptions)

    open_questions = [q for q in (doc.open_questions or []) if getattr(q, 'prompt', '').strip()]
    if open_questions:
        lines.extend(['', '## Open Questions'])
        for i, q in enumerate(open_questions, start=1):
            qid = str(getattr(q, 'id', '') or f'q-{i}').strip() or f'q-{i}'
            lines.append(f'<!-- q-id: {qid} -->')
            lines.append(f'- {q.prompt.strip()}')
            for opt in q.options or []:
                opt_text = str(opt).strip()
                if opt_text:
                    lines.append(f'  - {opt_text}')

    rollback = str(getattr(doc, 'rollback_notes', '') or '').strip()
    if rollback:
        lines.extend(['', '## Rollback Notes', rollback])

    dod = [str(d).strip() for d in (doc.definition_of_done or []) if str(d).strip()]
    if dod:
        lines.extend(['', '## Definition of Done'])
        lines.extend(f'- {d}' for d in dod)

    lines.extend(['', '## Action Steps'])
    action_steps = doc.action_steps or []
    rendered_any = False
    step_num = 0
    for step in action_steps:
        goal = getattr(step, 'goal', '') if not isinstance(step, str) else step
        if not str(goal).strip():
            continue
        step_num += 1
        if isinstance(step, ActionStep):
            lines.extend(_render_action_step(step, step_num))
        else:
            # Backward-compatible plain string step.
            lines.append(f'<!-- step-id: step-{step_num} -->')
            lines.append(f'- [ ] {str(goal).strip()}')
        rendered_any = True
    if not rendered_any:
        lines.append('- (none specified)')
    return '\n'.join(lines) + '\n'


def _parse_section_body(lines: list[str]) -> str:
    return '\n'.join(lines).strip()


def _parse_bullet_list(lines: list[str]) -> list[str]:
    rows: list[str] = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith('- '):
            text = stripped[2:].strip()
            if text and text != '(none specified)':
                rows.append(text)
    return rows


QUESTION_ID_COMMENT_RE = re.compile(r'<!--\s*q-id:\s*(\S+)\s*-->')


def _parse_open_questions(lines: list[str]) -> list[OpenQuestion]:
    """Parse the ``## Open Questions`` section into ``OpenQuestion`` models."""
    questions: list[OpenQuestion] = []
    current: OpenQuestion | None = None
    current_id: str | None = None
    for line in lines:
        comment = QUESTION_ID_COMMENT_RE.search(line)
        if comment:
            current_id = comment.group(1)
            continue
        if not line.strip():
            continue
        is_indented = line.startswith('  ') or line.startswith('\t')
        stripped = line.strip()
        if not is_indented and stripped.startswith('- '):
            prompt = stripped[2:].strip()
            if not prompt:
                continue
            current = OpenQuestion(id=current_id or f'q-{len(questions) + 1}', prompt=prompt)
            questions.append(current)
            current_id = None
            continue
        if current is not None and is_indented and stripped.startswith('- '):
            opt = stripped[2:].strip()
            if opt:
                current.options.append(opt)
    return questions


def parse_build_plan_md(md_text: str) -> BuildPlanModel:
    """Parse a build-plan Markdown document into a structured model."""

    title = ''
    sections: dict[str, list[str]] = {}
    current_key: str | None = None
    current_lines: list[str] = []

    for line in md_text.splitlines():
        title_match = BUILD_PLAN_TITLE_RE.match(line.strip())
        if title_match and not title:
            title = title_match.group(1).strip()
            continue
        section_match = SECTION_HEADER_RE.match(line.strip())
        if section_match:
            if current_key is not None:
                sections[current_key] = list(current_lines)
            current_key = section_match.group(1).strip().lower()
            current_lines = []
            continue
        if current_key is not None:
            current_lines.append(line)

    if current_key is not None:
        sections[current_key] = list(current_lines)

    parsed_steps = parse_action_steps(md_text)
    action_steps: list[ActionStep] = []
    for i, row in enumerate(parsed_steps, start=1):
        goal = str(row.get('text') or '').strip()
        if not goal:
            continue
        action_steps.append(
            ActionStep(
                id=str(row.get('id') or f'step-{i}'),
                goal=goal,
                files_touched=[str(f) for f in (row.get('files_touched') or []) if str(f).strip()],
                approach=str(row.get('approach') or '').strip(),
                acceptance_criteria=[str(c) for c in (row.get('acceptance_criteria') or []) if str(c).strip()],
                verification=str(row.get('verification') or '').strip(),
                risks=[str(r) for r in (row.get('risks') or []) if str(r).strip()],
            )
        )

    return BuildPlanModel(
        title=title or 'Build plan',
        task=_parse_section_body(sections.get('task', [])),
        current_implementation=_parse_section_body(sections.get('current implementation', [])),
        files_to_change=_parse_bullet_list(sections.get('files to change', [])),
        assumptions=_parse_bullet_list(sections.get('assumptions', [])),
        open_questions=_parse_open_questions(sections.get('open questions', [])),
        rollback_notes=_parse_section_body(sections.get('rollback notes', [])),
        definition_of_done=_parse_bullet_list(sections.get('definition of done', [])),
        action_steps=action_steps,
    )


def create_build_plan_draft(
    workspace_root: str,
    session_id: str,
    *,
    session: SessionState | None = None,
    conversation_title: str = '',
) -> BuildPlanRecord:
    """Create a drafting build-plan stub file and attach it to the session."""

    root_text = (workspace_root or '').strip()
    if not root_text:
        raise ValueError('workspace_root is required')

    plan_id = f'plan-{uuid.uuid4().hex[:12]}'
    relative_path = f'{BUILD_PLANS_REL_DIR}/{plan_id}.md'
    md_path = _md_path(root_text, relative_path)
    md_path.parent.mkdir(parents=True, exist_ok=True)
    md_path.write_text(BUILD_PLAN_DRAFT_STUB, encoding='utf-8')

    now = datetime.now(timezone.utc).isoformat()
    entry: dict[str, Any] = {
        'id': plan_id,
        'relativePath': relative_path,
        'sessionId': session_id,
        'conversationTitle': conversation_title,
        'createdAt': now,
        'status': 'drafting',
        'title': '',
    }
    entries = _load_index(root_text)
    entries.append(entry)
    entries = _evict_if_needed(root_text, entries)
    _save_index(root_text, entries)

    record = _entry_to_record(entry)
    if session is not None:
        attach_active_plan(session, record)
    return record


def write_build_plan_draft_content(
    workspace_root: str,
    record: BuildPlanRecord,
    md_text: str,
) -> None:
    """Overwrite a drafting build-plan file with the latest streamed markdown."""

    md_path = _md_path(workspace_root, record.relative_path)
    md_path.parent.mkdir(parents=True, exist_ok=True)
    text = md_text if md_text.endswith('\n') else md_text + '\n'
    md_path.write_text(text, encoding='utf-8')


def finalize_build_plan_draft(
    workspace_root: str,
    record: BuildPlanRecord,
    md_text: str,
) -> BuildPlanRecord:
    """Write final markdown and promote a drafting plan to active status."""

    root_text = (workspace_root or '').strip()
    write_build_plan_draft_content(root_text, record, md_text)
    doc = parse_build_plan_md(md_text)

    entries = _load_index(root_text)
    updated = record
    for entry in entries:
        if str(entry.get('id') or '') == record.id:
            entry['status'] = 'active'
            entry['title'] = doc.title.strip()
            updated = _entry_to_record(entry)
            break
    _save_index(root_text, entries)
    return updated


def create_build_plan(
    workspace_root: str,
    session_id: str,
    doc: Any,
    *,
    session: SessionState | None = None,
    conversation_title: str = '',
) -> BuildPlanRecord:
    """Write a new build plan MD file, update the registry, and attach to ``session`` when given."""

    root_text = (workspace_root or '').strip()
    if not root_text:
        raise ValueError('workspace_root is required')

    plan_id = f'plan-{uuid.uuid4().hex[:12]}'
    relative_path = f'{BUILD_PLANS_REL_DIR}/{plan_id}.md'
    md_path = _md_path(root_text, relative_path)
    md_path.parent.mkdir(parents=True, exist_ok=True)
    md_path.write_text(render_build_plan_md(doc), encoding='utf-8')

    now = datetime.now(timezone.utc).isoformat()
    entry: dict[str, Any] = {
        'id': plan_id,
        'relativePath': relative_path,
        'sessionId': session_id,
        'conversationTitle': conversation_title,
        'createdAt': now,
        'status': 'active',
        'title': str(getattr(doc, 'title', '') or '').strip(),
    }
    entries = _load_index(root_text)
    entries.append(entry)
    entries = _evict_if_needed(root_text, entries)
    _save_index(root_text, entries)

    record = _entry_to_record(entry)
    if session is not None:
        session.active_build_plan_id = record.id
        session.active_build_plan_path = record.relative_path
    return record


def get_active_plan(
    session: SessionState,
    *,
    chat_session_id: str | None = None,
) -> BuildPlanRecord | None:
    """Resolve the session's active build plan from the workspace registry."""

    workspace_root = (session.workspace_path or '').strip()
    if not workspace_root:
        return None

    plan_id = (session.active_build_plan_id or '').strip()
    if plan_id:
        for entry in _load_index(workspace_root):
            if str(entry.get('id') or '') == plan_id:
                return _entry_to_record(entry)

    sid = (chat_session_id or '').strip()
    if not sid:
        return None

    candidates = [
        entry
        for entry in _load_index(workspace_root)
        if str(entry.get('sessionId') or '') == sid and str(entry.get('status') or '') == 'active'
    ]
    if not candidates:
        return None
    candidates.sort(key=lambda entry: str(entry.get('createdAt') or ''))
    record = _entry_to_record(candidates[-1])
    attach_active_plan(session, record)
    return record


def read_build_plan_text(
    session: SessionState,
    *,
    chat_session_id: str | None = None,
) -> str:
    """Return full MD for the active plan (raises ``FileNotFoundError`` when missing)."""

    record = get_active_plan(session, chat_session_id=chat_session_id)
    if record is None:
        raise FileNotFoundError('No active build plan for this session.')
    path = _md_path(session.workspace_path, record.relative_path)
    return path.read_text(encoding='utf-8')


_ACTION_STEP_DETAIL_KEY_RE = re.compile(r'^-\s*\*\*([^*:]+):\*\*\s*(.*)$')


def _merge_action_step_details(step: dict[str, Any], detail_lines: list[str]) -> None:
    """Fold nested ``**Key:**`` detail bullets into an enriched step dict."""
    current_list_key: str | None = None
    for raw in detail_lines:
        if not raw.strip():
            current_list_key = None
            continue
        indent = len(raw) - len(raw.lstrip())
        line = raw.strip()
        if indent >= 4 and current_list_key is not None:
            item = line.lstrip('- ').strip()
            if item:
                step.setdefault(current_list_key, []).append(item)
            continue
        match = _ACTION_STEP_DETAIL_KEY_RE.match(line)
        if not match:
            current_list_key = None
            continue
        key = match.group(1).strip().lower()
        rest = match.group(2).strip()
        current_list_key = None
        if key == 'files':
            step['files_touched'] = [f.strip() for f in rest.split(',') if f.strip()]
        elif key == 'approach':
            step['approach'] = rest
        elif key == 'verification':
            step['verification'] = rest
        elif key == 'acceptance criteria':
            step['acceptance_criteria'] = []
            current_list_key = 'acceptance_criteria'
            if rest:
                step['acceptance_criteria'].append(rest)
        elif key == 'risks':
            step['risks'] = []
            current_list_key = 'risks'
            if rest:
                step['risks'].append(rest)


def parse_action_steps(md_text: str) -> list[dict[str, Any]]:
    """Parse action-step checkboxes (and nested enriched details) from build-plan Markdown."""

    steps: list[dict[str, Any]] = []
    current_id: str | None = None
    pending: dict[str, Any] | None = None
    detail_lines: list[str] = []

    def _flush() -> None:
        nonlocal pending, detail_lines
        if pending is not None:
            _merge_action_step_details(pending, detail_lines)
            steps.append(pending)
            pending = None
            detail_lines = []

    for line in md_text.splitlines():
        comment = STEP_ID_COMMENT_RE.search(line)
        if comment:
            _flush()
            current_id = comment.group(1)
            continue
        checkbox = CHECKBOX_LINE_RE.match(line.strip())
        if checkbox:
            if current_id:
                _flush()
                pending = {
                    'id': current_id,
                    'text': checkbox.group(2).strip(),
                    'complete': checkbox.group(1).lower() == 'x',
                    'files_touched': [],
                    'approach': '',
                    'acceptance_criteria': [],
                    'verification': '',
                    'risks': [],
                }
                current_id = None
            else:
                _flush()
            continue
        if pending is not None and (line.startswith('  ') or line.startswith('\t')):
            detail_lines.append(line)
            continue
        if pending is not None:
            _flush()
    _flush()
    return steps


def mark_steps_complete(
    workspace_root: str,
    record: BuildPlanRecord,
    step_ids: list[str],
) -> list[dict[str, Any]]:
    """Flip matching ``- [ ]`` rows to ``- [x]`` and return parsed step states."""

    want = {sid.strip() for sid in step_ids if sid.strip()}
    if not want:
        return parse_action_steps(read_build_plan_md(workspace_root, record))

    known = {row['id'] for row in parse_action_steps(read_build_plan_md(workspace_root, record))}
    unknown = want - known
    if unknown:
        raise ValueError(f'Unknown step id(s): {", ".join(sorted(unknown))}')

    md_path = _md_path(workspace_root, record.relative_path)
    original = md_path.read_text(encoding='utf-8')
    current_id: str | None = None
    out_lines: list[str] = []
    for line in original.splitlines():
        comment = STEP_ID_COMMENT_RE.search(line)
        if comment:
            current_id = comment.group(1)
            out_lines.append(line)
            continue
        checkbox = CHECKBOX_LINE_RE.match(line.strip())
        if checkbox and current_id and current_id in want:
            out_lines.append(f'- [x] {checkbox.group(2).strip()}')
            current_id = None
            continue
        out_lines.append(line)
        if checkbox:
            current_id = None

    trailing_newline = original.endswith('\n')
    updated = '\n'.join(out_lines)
    if trailing_newline:
        updated += '\n'
    md_path.write_text(updated, encoding='utf-8')
    return parse_action_steps(updated)


def read_build_plan_md(workspace_root: str, record: BuildPlanRecord) -> str:
    return _md_path(workspace_root, record.relative_path).read_text(encoding='utf-8')


def planner_progress_payload_from_parsed(
    parsed: list[dict[str, Any]],
    *,
    phase: str = 'executing',
    plan_ready: bool = False,
) -> dict[str, Any]:
    from nemo_backend.stream_tags import PLANNER_STREAM_TAG

    steps = [
        {
            'id': str(row.get('id') or ''),
            'text': str(row.get('text') or ''),
            'state': 'complete' if row.get('complete') else 'pending',
        }
        for row in parsed
    ]
    return {
        'streamTag': PLANNER_STREAM_TAG,
        'phase': phase,
        'planReady': plan_ready,
        'steps': steps,
    }


def delete_build_plan(workspace_root: str, plan_id: str) -> bool:
    """Remove a plan from the registry and delete its Markdown file."""

    root_text = (workspace_root or '').strip()
    plan_key = (plan_id or '').strip()
    if not root_text or not plan_key:
        return False

    entries = _load_index(root_text)
    kept: list[dict[str, Any]] = []
    removed = False
    for entry in entries:
        if str(entry.get('id') or '') == plan_key:
            removed = True
            _delete_entry_files(root_text, entry)
        else:
            kept.append(entry)
    if removed:
        _save_index(root_text, kept)
    return removed


def complete_build_plan(session: SessionState, plan_id: str | None = None) -> None:
    """Mark a registry entry ``complete`` (file remains on disk)."""

    set_build_plan_status(session, plan_id or session.active_build_plan_id or '', 'complete')


def set_build_plan_status(session: SessionState, plan_id: str, status: str) -> None:
    """Update registry status for a build plan (``active`` | ``complete`` | ``cancelled``)."""

    pid = (plan_id or '').strip()
    workspace_root = (session.workspace_path or '').strip()
    if not pid or not workspace_root:
        return
    entries = _load_index(workspace_root)
    for entry in entries:
        if str(entry.get('id') or '') == pid:
            entry['status'] = status
            break
    _save_index(workspace_root, entries)


def attach_active_plan(session: SessionState, record: BuildPlanRecord) -> None:
    session.active_build_plan_id = record.id
    session.active_build_plan_path = record.relative_path


def cancel_build_plan(session: SessionState, plan_id: str) -> bool:
    """Delete plan file + registry entry and clear session attachment when it matches."""

    pid = (plan_id or '').strip()
    if not pid:
        return False
    removed = delete_build_plan(session.workspace_path, pid)
    if removed and session.active_build_plan_id == pid:
        session.active_build_plan_id = ''
        session.active_build_plan_path = ''
    return removed


__all__ = [
    'BUILD_PLANS_REL_DIR',
    'BUILD_PLAN_DRAFT_STUB',
    'ActionStep',
    'BuildPlanModel',
    'BuildPlanRecord',
    'MAX_BUILD_PLANS',
    'OpenQuestion',
    'attach_active_plan',
    'cancel_build_plan',
    'complete_build_plan',
    'create_build_plan',
    'create_build_plan_draft',
    'delete_build_plan',
    'finalize_build_plan_draft',
    'get_active_plan',
    'mark_steps_complete',
    'parse_action_steps',
    'parse_build_plan_md',
    'planner_progress_payload_from_parsed',
    'read_build_plan_md',
    'read_build_plan_text',
    'render_build_plan_md',
    'set_build_plan_status',
    'write_build_plan_draft_content',
]
