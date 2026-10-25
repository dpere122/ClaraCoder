"""Verify a build plan's file paths against the workspace before asking the user about them.

The planner names files from discovery notes, so a path can be misspelled, stale, or invented.
Looking at the disk is instant and exact; only real ambiguity becomes a clarifying question:

- a modify/delete path that exists: nothing to ask;
- missing, and exactly one workspace file has that name (or one clearly best match): the path is
  corrected and the fix recorded as an assumption;
- missing, several files have that name: ask which one, with the real paths as options;
- missing, no such file: a delete is dropped (nothing to remove); a modify asks create-or-clarify.

Path answers then fix the plan directly — they never need another discovery pass or a rewrite.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from clara_coder_backend.plan.build_plan_store import BuildPlanModel, OpenQuestion, clean_plan_path
from clara_coder_backend.workspace.paths import normalize_relative_path
from clara_coder_backend.workspace.workspace_ignore import (
    get_workspace_ignore_rules_cached,
    iter_workspace_search_files,
)

__all__ = [
    'PATH_CLARIFY',
    'PATH_CREATE',
    'PATH_QID_PREFIX',
    'PathAnswerOutcome',
    'PathVerification',
    'apply_path_answers',
    'is_path_question',
    'verify_plan_paths',
]

PATH_QID_PREFIX = 'q-path-'
PATH_CREATE = 'Create it as a new file'
PATH_CLARIFY = 'Cancel and let me clarify'
MAX_PATH_CANDIDATES = 4
# Name lookup walks the workspace once; stop early on huge trees rather than stall planning.
SCAN_FILE_LIMIT = 60_000


@dataclass
class PathCheck:
    """One unresolved planned path and the workspace files that could be meant."""

    question_id: str
    path: str
    operation: str
    candidates: list[str]


@dataclass
class PathVerification:
    questions: list[OpenQuestion] = field(default_factory=list)
    checks: dict[str, PathCheck] = field(default_factory=dict)
    #: Silent fixes (corrected / dropped paths), already added to the plan's assumptions.
    notes: list[str] = field(default_factory=list)

    @property
    def changed(self) -> bool:
        return bool(self.notes)


@dataclass
class PathAnswerOutcome:
    #: Planned paths the user wants to clarify before planning goes on.
    clarify: list[str] = field(default_factory=list)
    #: A typed answer that is not a workspace path: the planner has to read it.
    needs_replan: bool = False


def is_path_question(question: OpenQuestion) -> bool:
    return str(question.id or '').startswith(PATH_QID_PREFIX)


def _norm(path: str) -> str:
    return clean_plan_path(path)


def _exists(root: Path, path: str) -> bool:
    try:
        return normalize_relative_path(root, path).exists()
    except (ValueError, OSError):
        return False


def _basename(path: str) -> str:
    return _norm(path).rsplit('/', 1)[-1].lower()


def _files_by_name(root: Path, names: set[str]) -> dict[str, list[str]]:
    found: dict[str, list[str]] = {name: [] for name in names}
    resolved = root.resolve()
    rules = get_workspace_ignore_rules_cached(resolved)
    for i, file_path in enumerate(iter_workspace_search_files(resolved, rules)):
        if i >= SCAN_FILE_LIMIT:
            break
        key = file_path.name.lower()
        if key in found:
            found[key].append(file_path.relative_to(resolved).as_posix())
    return found


def _shared_tail(planned: str, candidate: str) -> int:
    """Trailing path segments the two paths share (``src/a/b.ts`` vs ``lib/a/b.ts`` → 2)."""
    a = _norm(planned).lower().split('/')
    b = candidate.lower().split('/')
    n = 0
    while n < min(len(a), len(b)) and a[-1 - n] == b[-1 - n]:
        n += 1
    return n


def _rank(planned: str, candidates: list[str]) -> list[str]:
    return sorted(candidates, key=lambda c: (-_shared_tail(planned, c), len(c), c))


def _clear_match(planned: str, ranked: list[str]) -> str | None:
    """The one candidate to use without asking: the only one, or the only one sharing a parent dir."""
    if len(ranked) == 1:
        return ranked[0]
    if len(ranked) > 1:
        best = _shared_tail(planned, ranked[0])
        if best >= 2 and _shared_tail(planned, ranked[1]) < best:
            return ranked[0]
    return None


def _rename(plan: BuildPlanModel, old: str, new: str) -> None:
    key = _norm(old)
    for entry in plan.files_to_change:
        if _norm(entry.path) == key:
            entry.path = new
    for step in plan.action_steps:
        step.files_touched = [new if _norm(p) == key else p for p in step.files_touched]


def _drop(plan: BuildPlanModel, path: str) -> None:
    key = _norm(path)
    plan.files_to_change = [e for e in plan.files_to_change if _norm(e.path) != key]
    for step in plan.action_steps:
        step.files_touched = [p for p in step.files_touched if _norm(p) != key]


def _add_assumptions(plan: BuildPlanModel, lines: list[str]) -> None:
    current = [str(a).strip() for a in (plan.assumptions or []) if str(a).strip()]
    for line in lines:
        if line not in current:
            current.append(line)
    plan.assumptions = current


def verify_plan_paths(plan: BuildPlanModel, workspace_root: str) -> PathVerification:
    """Check modify/delete paths on disk; fix the obvious ones in place and return questions for the rest."""
    result = PathVerification()
    root_text = (workspace_root or '').strip()
    if not root_text or not Path(root_text).is_dir():
        return result
    root = Path(root_text)

    missing: list[tuple[str, str]] = []
    seen: set[str] = set()
    for entry in plan.files_to_change:
        path = _norm(entry.path)
        operation = str(entry.operation or 'modify').lower()
        if not path or operation == 'create' or path.lower() in seen:
            continue
        seen.add(path.lower())
        if not _exists(root, path):
            missing.append((path, operation))
    if not missing:
        return result

    found = _files_by_name(root, {_basename(p) for p, _ in missing})
    for path, operation in missing:
        ranked = _rank(path, found.get(_basename(path), []))
        match = _clear_match(path, ranked)
        if match:
            _rename(plan, path, match)
            result.notes.append(f'Path corrected: {path} → {match} ({path} does not exist).')
            continue
        if not ranked and operation == 'delete':
            _drop(plan, path)
            result.notes.append(f'Skipped deleting {path}: it is not in the workspace.')
            continue

        qid = f'{PATH_QID_PREFIX}{len(result.questions) + 1}'
        verb = 'deletes' if operation == 'delete' else 'edits'
        if ranked:
            question = OpenQuestion(
                id=qid,
                prompt=f'The plan {verb} "{path}", which does not exist. Which file did you mean?',
                options=ranked[:MAX_PATH_CANDIDATES],
            )
        else:
            question = OpenQuestion(
                id=qid,
                prompt=f'The plan edits "{path}", but no file by that name exists in the workspace. Create it?',
                options=[PATH_CREATE, PATH_CLARIFY],
            )
        result.questions.append(question)
        result.checks[qid] = PathCheck(question_id=qid, path=path, operation=operation, candidates=ranked)

    _add_assumptions(plan, result.notes)
    return result


def apply_path_answers(
    plan: BuildPlanModel,
    verification: PathVerification,
    answer_text_by_qid: dict[str, str],
    workspace_root: str,
) -> PathAnswerOutcome:
    """Apply the user's path answers to the plan (rename / create / clarify)."""
    outcome = PathAnswerOutcome()
    root = Path((workspace_root or '').strip() or '.')
    notes: list[str] = []
    for qid, check in verification.checks.items():
        text = (answer_text_by_qid.get(qid) or '').strip()
        if not text:
            continue
        if text == PATH_CLARIFY:
            outcome.clarify.append(check.path)
        elif text == PATH_CREATE:
            for entry in plan.files_to_change:
                if _norm(entry.path) == _norm(check.path):
                    entry.operation = 'create'
            notes.append(f'{check.path} will be created (it does not exist yet).')
        elif text in check.candidates or _exists(root, text):
            chosen = _norm(text)
            _rename(plan, check.path, chosen)
            notes.append(f'You chose {chosen} for {check.path}.')
        else:
            # Free text that is not a path ("the one under lib"): leave it to the planner.
            outcome.needs_replan = True
    _add_assumptions(plan, notes)
    return outcome
