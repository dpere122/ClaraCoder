"""Context for attaching nested final-review command output to ``reject_project_review``."""

from __future__ import annotations

import contextvars

from nemo_backend.state import get_session
from nemo_backend.workspace_tools import truncate_text

# Match project review pytest/smoke stash budget.
_SUBPROCESS_STASH_MAX_CHARS = 80_000

nested_project_review_output_capture: contextvars.ContextVar[bool] = contextvars.ContextVar(
    'nested_project_review_output_capture', default=False
)


def append_nested_review_command_output(session_id: str, title: str, body: str) -> None:
    """Append labeled output to :attr:`SessionState.last_project_review_subprocess_report` when capture is on."""

    if not nested_project_review_output_capture.get():
        return
    sid = (session_id or '').strip()
    if not sid:
        return
    text = (body or '').strip()
    if not text:
        return
    session = get_session(sid)
    chunk = f'\n\n### {title}\n{text}'
    prev = (session.last_project_review_subprocess_report or '').strip()
    merged = f'{prev}{chunk}'.strip() if prev else chunk.strip()
    session.last_project_review_subprocess_report = truncate_text(merged, _SUBPROCESS_STASH_MAX_CHARS)
