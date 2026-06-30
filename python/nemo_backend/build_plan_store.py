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
    action_steps: list[str] = Field(
        default_factory=list,
        description='Ordered milestone steps the executor should accomplish.',
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
    lines.extend(['', '## Action Steps'])
    step_num = 0
    for step in doc.action_steps or []:
        text = str(step).strip()
        if not text:
            continue
        step_num += 1
        step_id = f'step-{step_num}'
        lines.append(f'<!-- step-id: {step_id} -->')
        lines.append(f'- [ ] {text}')
    return '\n'.join(lines) + '\n'


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


def parse_action_steps(md_text: str) -> list[dict[str, Any]]:
    """Parse action-step checkboxes from build-plan Markdown."""

    steps: list[dict[str, Any]] = []
    current_id: str | None = None
    for line in md_text.splitlines():
        comment = STEP_ID_COMMENT_RE.search(line)
        if comment:
            current_id = comment.group(1)
            continue
        checkbox = CHECKBOX_LINE_RE.match(line.strip())
        if checkbox and current_id:
            steps.append(
                {
                    'id': current_id,
                    'text': checkbox.group(2).strip(),
                    'complete': checkbox.group(1).lower() == 'x',
                }
            )
            current_id = None
        elif checkbox:
            current_id = None
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
    'BuildPlanModel',
    'BuildPlanRecord',
    'MAX_BUILD_PLANS',
    'attach_active_plan',
    'cancel_build_plan',
    'complete_build_plan',
    'create_build_plan',
    'delete_build_plan',
    'get_active_plan',
    'mark_steps_complete',
    'parse_action_steps',
    'planner_progress_payload_from_parsed',
    'read_build_plan_md',
    'read_build_plan_text',
    'render_build_plan_md',
    'set_build_plan_status',
]
