"""Build plan Markdown persistence under ``.clara/build-plans/``."""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from clara_coder_backend.domain import SessionState
from clara_coder_backend.workspace.meta import (
    BUILD_PLANS_REL_DIR,
    migrate_legacy_workspace_meta_dir,
    rewrite_legacy_build_plan_relative_path,
)

MAX_BUILD_PLANS = 5
INDEX_FILENAME = 'index.json'

STEP_ID_COMMENT_RE = re.compile(r'<!--\s*step-id:\s*(\S+)\s*-->')
CHECKBOX_LINE_RE = re.compile(r'^- \[( |x|X)\] (.*)$')
BUILD_PLAN_TITLE_RE = re.compile(r'^#\s*Build\s+Plan:\s*(.+)$', re.IGNORECASE)
SECTION_HEADER_RE = re.compile(r'^##\s+(.+)$')
FILE_CHANGE_OP_RE = re.compile(
    r'^\[(create|modify|delete)\]\s+(.+)$',
    re.IGNORECASE,
)

BUILD_PLAN_DRAFT_STUB = '# Build Plan\n\n_Generating plan…_\n'
BUILD_PLAN_REWRITE_STUB = '# Build Plan\n\n_Rewriting plan…_\n'

FileOperation = Literal['create', 'modify', 'delete']
_FILE_OPERATIONS: frozenset[str] = frozenset({'create', 'modify', 'delete'})


class OpenQuestion(BaseModel):
    """A clarifying question the planner surfaces to the user before execution."""

    id: str = Field(description='Stable id like q-1.')
    prompt: str = Field(description='The question to ask the user.')
    options: list[str] = Field(
        default_factory=list,
        description='Suggested answers the user can pick. The UI always appends an "Other" free-text choice.',
    )


_MD_LINK_PATH_RE = re.compile(r'^\[[^\]]*\]\(([^)\s]+)\)')
# ``a.ts:85``, ``a.ts:12-34``, ``a.ts:12:4``, ``a.ts#L10``, ``a.ts#L10-L20``
_PATH_LOCATION_SUFFIX_RE = re.compile(r'(?:#L\d+(?:-L?\d+)?|:\d+(?:[-:]\d+)?)$')
_PATH_TRAILING_NOTE_RE = re.compile(r'\s+\([^()]*\)$')


def clean_plan_path(text: object) -> str:
    """Reduce a planner-written path to a plain workspace-relative path.

    Planners write paths the way they write prose: in backticks, as markdown links, with a line
    number (``src/a.ts:85``) or a note (``src/a.ts (new)``). Left as-is, none of those match a file
    on disk, so every check downstream misreads a real file as missing.
    """
    s = str(text or '').strip()
    link = _MD_LINK_PATH_RE.match(s)
    if link:
        s = link.group(1)
    # Quotes / emphasis on both ends; sentence punctuation only at the end (keeps ``./`` and ``.github``).
    for _ in range(2):
        s = _PATH_TRAILING_NOTE_RE.sub('', s.strip('`*"\' ')).rstrip('.,; ')
    s = _PATH_LOCATION_SUFFIX_RE.sub('', s)
    s = s.replace('\\', '/')
    while s.startswith('./'):
        s = s[2:]
    s = s.strip()
    # A bare line list left over from ``a.ts:144, 178`` split on commas is not a path.
    return '' if re.fullmatch(r'[\d\s,:\-–]*', s) else s


class FileChangeEntry(BaseModel):
    """One planned file create, modify, or delete with rationale."""

    path: str = Field(description='Workspace-relative path.')
    operation: FileOperation = Field(
        default='modify',
        description='Whether the plan creates, modifies, or deletes this path.',
    )
    rationale: str = Field(
        default='',
        description='Brief reason for the file operation.',
    )

    @field_validator('path', mode='before')
    @classmethod
    def _clean_path(cls, value: object) -> str:
        return clean_plan_path(value)


class ActionStep(BaseModel):
    """One enriched, verifiable milestone in a build plan."""

    id: str = Field(description='Stable id like step-1.')
    goal: str = Field(description='The milestone outcome in one line (renders on the checkbox).')
    files_touched: list[str] = Field(
        default_factory=list,
        description='Workspace-relative paths this step creates, modifies, or deletes.',
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

    @field_validator('files_touched', mode='before')
    @classmethod
    def _clean_files(cls, value: object) -> list[str]:
        items = value if isinstance(value, list) else [value] if value else []
        cleaned = [clean_plan_path(item) for item in items]
        return [p for p in cleaned if p]


class BuildPlanModel(BaseModel):
    """Structured planner output for a build plan document."""

    title: str = Field(description='Short title for the build plan.')
    task: str = Field(description='What the user asked for and the objective.')
    current_implementation: str = Field(
        description='How the codebase currently handles this area (facts from discovery).',
    )
    files_to_change: list[FileChangeEntry] = Field(
        default_factory=list,
        description=(
            'Files the plan will create, modify, or delete. '
            'Each entry has path, operation (create|modify|delete), and rationale.'
        ),
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

    @field_validator('files_to_change', mode='before')
    @classmethod
    def _coerce_files_to_change(cls, value: Any) -> list[FileChangeEntry]:
        if not value:
            return []
        if not isinstance(value, list):
            value = [value]
        out: list[FileChangeEntry] = []
        for item in value:
            entry = coerce_file_change_entry(item)
            if entry is not None:
                out.append(entry)
        return out


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
    migrate_legacy_workspace_meta_dir(workspace_root)
    return Path(workspace_root).resolve() / BUILD_PLANS_REL_DIR


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
        relative_path=rewrite_legacy_build_plan_relative_path(
            str(entry.get('relativePath') or '').replace('\\', '/'),
        ),
        session_id=str(entry.get('sessionId') or ''),
        title=str(entry.get('title') or ''),
        created_at=str(entry.get('createdAt') or ''),
        status=str(entry.get('status') or 'active'),
        conversation_title=str(entry.get('conversationTitle') or ''),
    )


def _md_path(workspace_root: str | Path, relative_path: str) -> Path:
    return Path(workspace_root).resolve() / relative_path.replace('\\', '/')


def _delete_entry_files(workspace_root: str | Path, entry: dict[str, Any]) -> None:
    rel = rewrite_legacy_build_plan_relative_path(
        str(entry.get('relativePath') or '').replace('\\', '/'),
    )
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
        '## File Changes',
    ]
    file_entries = _coerce_file_change_entries(doc.files_to_change or [])
    if file_entries:
        lines.extend(f'- {_format_file_change_bullet(entry)}' for entry in file_entries)
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


def _split_path_rationale(text: str) -> tuple[str, str]:
    """Split ``path — rationale`` (em/en dash) into path and rationale.

    A leading backticked path ends at its closing backtick, so ``\\`a.ts\\`: why`` and
    ``\\`a.ts\\` - why`` split too.
    """
    stripped = text.strip()
    if stripped.startswith('`') and '`' in stripped[1:]:
        end = stripped.index('`', 1)
        rest = stripped[end + 1 :].strip().lstrip('—–-:').strip()
        return stripped[: end + 1], rest
    for sep in ('—', '–'):
        if sep in text:
            left, right = text.split(sep, 1)
            return left.strip(), right.strip()
    return text.strip(), ''


def _normalize_file_operation(value: object) -> FileOperation:
    op = str(value or '').strip().lower()
    if op in _FILE_OPERATIONS:
        return op  # type: ignore[return-value]
    return 'modify'


def coerce_file_change_entry(raw: object) -> FileChangeEntry | None:
    """Normalize a FileChangeEntry, dict, or legacy ``path — rationale`` string."""
    if isinstance(raw, FileChangeEntry):
        path = raw.path.strip()
        if not path:
            return None
        return FileChangeEntry(
            path=path,
            operation=_normalize_file_operation(raw.operation),
            rationale=str(raw.rationale or '').strip(),
        )
    if isinstance(raw, dict):
        path = str(raw.get('path') or '').strip()
        if not path:
            return None
        return FileChangeEntry(
            path=path,
            operation=_normalize_file_operation(raw.get('operation')),
            rationale=str(raw.get('rationale') or '').strip(),
        )
    text = str(raw or '').strip()
    if not text or text == '(none specified)':
        return None
    tagged = FILE_CHANGE_OP_RE.match(text)
    if tagged:
        operation = _normalize_file_operation(tagged.group(1))
        path, rationale = _split_path_rationale(tagged.group(2).strip())
        if not path:
            return None
        return FileChangeEntry(path=path, operation=operation, rationale=rationale)
    path, rationale = _split_path_rationale(text)
    if not path:
        return None
    return FileChangeEntry(path=path, operation='modify', rationale=rationale)


def _coerce_file_change_entries(raw_items: list[Any]) -> list[FileChangeEntry]:
    out: list[FileChangeEntry] = []
    for item in raw_items:
        entry = coerce_file_change_entry(item)
        if entry is not None:
            out.append(entry)
    return out


def _format_file_change_bullet(entry: FileChangeEntry) -> str:
    path = entry.path.strip()
    rationale = entry.rationale.strip()
    op = _normalize_file_operation(entry.operation)
    if rationale:
        return f'[{op}] {path} — {rationale}'
    return f'[{op}] {path}'


def _parse_file_change_entries(lines: list[str]) -> list[FileChangeEntry]:
    """Parse ``## File Changes`` / legacy ``## Files to Change`` bullets."""
    return _coerce_file_change_entries(_parse_bullet_list(lines))


QUESTION_ID_COMMENT_RE = re.compile(r'<!--\s*q-id:\s*(\S+)\s*-->')
_QUESTION_BULLET_RE = re.compile(r'^\s*(?:[-*+]\s+|\d+[.)]\s+)(.*)$')
# Explicit labels the LLM sometimes emits — used to decide question vs option role.
_QUESTION_LABEL_RE = re.compile(
    r'^(?:question|q\d*|discovery|clarification|prompt)\s*\d*\s*:\s*',
    re.IGNORECASE,
)
_OPTION_LABEL_RE = re.compile(
    r'^(?:option|opt\d*|choice|answer|a)\s*\d*\s*:\s*',
    re.IGNORECASE,
)


def _strip_bold(text: str) -> str:
    return text.replace('**', '').strip()


def _strip_question_label(text: str) -> str:
    """Strip leading 'Question:' / 'Option 1:' / 'Discovery:' style labels the LLM sometimes emits."""
    return (_OPTION_LABEL_RE.sub('', _QUESTION_LABEL_RE.sub('', text, count=1), count=1)).strip()


def _parse_open_questions(lines: list[str]) -> list[OpenQuestion]:
    """Parse the ``## Open Questions`` section into ``OpenQuestion`` models.

    Tolerant of common LLM markdown variants:
    - ``-``/``*``/``+`` bullets or ``1.`` numbered prompts.
    - Optional ``<!-- q-id: q-N -->`` markers.
    - ``**bold**`` prompts.
    - Explicit ``Question:`` / ``Option N:`` labels (role detected from label, then stripped).
    - Flat lists where a ``?`` question is followed by non-``?`` statement options
      (LLM often does not indent options).
    """
    questions: list[OpenQuestion] = []
    current: OpenQuestion | None = None
    current_id: str | None = None

    def _new_question(prompt: str) -> OpenQuestion:
        nonlocal current, current_id
        current = OpenQuestion(id=current_id or f'q-{len(questions) + 1}', prompt=prompt)
        questions.append(current)
        current_id = None
        return current

    for line in lines:
        comment = QUESTION_ID_COMMENT_RE.search(line)
        if comment:
            current_id = comment.group(1)
            continue
        if not line.strip():
            continue
        is_indented = line.startswith('  ') or line.startswith('\t')
        bullet_match = _QUESTION_BULLET_RE.match(line)
        if not bullet_match:
            continue
        raw_body = bullet_match.group(1)
        body = _strip_question_label(_strip_bold(raw_body))
        if not body:
            continue

        is_option_label = bool(_OPTION_LABEL_RE.match(raw_body))
        is_question_label = bool(_QUESTION_LABEL_RE.match(raw_body))

        if is_option_label:
            if current is not None:
                current.options.append(body)
            else:
                _new_question(body)
            continue
        if is_question_label:
            _new_question(body)
            continue

        # No explicit label — fall back to indentation + '?' cue.
        if is_indented:
            if current is not None:
                current.options.append(body)
            else:
                _new_question(body)
            continue

        # Flat (non-indented), no label: a '?' line starts a new question; a non-'?' line
        # right after a question is treated as one of its options (LLM often lists options flat).
        if current is not None and not body.rstrip().endswith('?') and len(current.options) < 8:
            current.options.append(body)
        else:
            _new_question(body)
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

    file_section_lines = sections.get('file changes') or sections.get('files to change') or []
    return BuildPlanModel(
        title=title or 'Build plan',
        task=_parse_section_body(sections.get('task', [])),
        current_implementation=_parse_section_body(sections.get('current implementation', [])),
        files_to_change=_parse_file_change_entries(file_section_lines),
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

    # Migrate ``.nemo`` → ``.clara`` before creating ``.clara/build-plans/``.
    _build_plans_root(root_text)

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

    root_text = (workspace_root or '').strip()
    if root_text:
        # First touch can create ``.clara``; migrate leftover ``.nemo`` first.
        _build_plans_root(root_text)

    rel = rewrite_legacy_build_plan_relative_path(record.relative_path)
    md_path = _md_path(workspace_root, rel)
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

    # Migrate ``.nemo`` → ``.clara`` before creating ``.clara/build-plans/``.
    _build_plans_root(root_text)

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
        session.plans.active_build_plan_id = record.id
        session.plans.active_build_plan_path = record.relative_path
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

    plan_id = (session.plans.active_build_plan_id or '').strip()
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
            _flush()
            # LLMs frequently omit the ``<!-- step-id: step-N -->`` marker even when asked to
            # emit it. Drop the checkbox here and the whole plan gets discarded as "empty", so
            # fall back to a positional id instead of skipping the step.
            step_id = current_id or f'step-{len(steps) + 1}'
            pending = {
                'id': step_id,
                'text': checkbox.group(2).strip(),
                'complete': checkbox.group(1).lower() == 'x',
                'files_touched': [],
                'approach': '',
                'acceptance_criteria': [],
                'verification': '',
                'risks': [],
            }
            current_id = None
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
    checkbox_ordinal = 0
    out_lines: list[str] = []
    for line in original.splitlines():
        comment = STEP_ID_COMMENT_RE.search(line)
        if comment:
            current_id = comment.group(1)
            out_lines.append(line)
            continue
        checkbox = CHECKBOX_LINE_RE.match(line.strip())
        if checkbox:
            checkbox_ordinal += 1
            # Prefer an explicit step-id comment; fall back to the positional id the parser
            # assigns when the LLM omitted the marker.
            effective_id = current_id or f'step-{checkbox_ordinal}'
            if effective_id in want:
                out_lines.append(f'- [x] {checkbox.group(2).strip()}')
            else:
                out_lines.append(line)
            current_id = None
            continue
        out_lines.append(line)

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
    from clara_coder_backend.stream_tags import PLANNER_STREAM_TAG

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

    set_build_plan_status(session, plan_id or session.plans.active_build_plan_id or '', 'complete')


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
    session.plans.active_build_plan_id = record.id
    session.plans.active_build_plan_path = record.relative_path


def cancel_build_plan(session: SessionState, plan_id: str) -> bool:
    """Delete plan file + registry entry and clear session attachment when it matches."""

    pid = (plan_id or '').strip()
    if not pid:
        return False
    removed = delete_build_plan(session.workspace_path, pid)
    if removed and session.plans.active_build_plan_id == pid:
        session.plans.active_build_plan_id = ''
        session.plans.active_build_plan_path = ''
    return removed


__all__ = [
    'BUILD_PLANS_REL_DIR',
    'BUILD_PLAN_DRAFT_STUB',
    'BUILD_PLAN_REWRITE_STUB',
    'ActionStep',
    'BuildPlanModel',
    'BuildPlanRecord',
    'FileChangeEntry',
    'FileOperation',
    'MAX_BUILD_PLANS',
    'OpenQuestion',
    'attach_active_plan',
    'cancel_build_plan',
    'coerce_file_change_entry',
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
