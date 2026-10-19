"""User interactive PTY terminal inspection tool and session state store.

Electron main mirrors active ``node-pty`` sessions and their output streams to this
store via ``/workspace-pty/*`` routes. The outer agent can inspect active user
terminals with :data:`check_user_terminals_tool` in both read-only and Editor modes.
"""

from __future__ import annotations

import os
import re
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated

from langchain_core.tools import tool

from clara_coder_backend.session.state import current_session_id, get_session
from clara_coder_backend.tools.tool_conventions import (
    clip_line,
    describe,
    tool_errors_as_text,
    tool_output_cap,
)

CHECK_USER_TERMINALS_NAME = 'check_user_terminals'

_MAX_PTY_CAPTURE_CHARS = 200_000
_DEFAULT_TAIL_LINES = 80
_MAX_TAIL_LINES = 500
_EXITED_TTL_SEC = 10 * 60

# ANSI / VT100 escape sequences and OSC 7 working-directory escapes.
_ANSI_ESCAPE_RE = re.compile(
    r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)'
    r'|\x1b\[[0-?]*[ -/]*[@-~]'
    r'|\x1b[@-_]'
)

__all__ = [
    'CHECK_USER_TERMINALS_NAME',
    'UserPtyTerminalSession',
    'append_user_pty_output',
    'check_user_terminals_tool',
    'clear_all_user_pty_terminals',
    'mark_user_pty_exited',
    'register_user_pty_terminal',
    'remove_user_pty_terminal',
    'update_user_pty_cwd',
    'user_pty_terminals',
]


@dataclass
class UserPtyTerminalSession:
    """In-memory mirror of one interactive ``node-pty`` shell in Electron."""

    session_id: str
    workspace_root: str
    cwd: str
    shell: str = ''
    pid: int | None = None
    cols: int = 80
    rows: int = 24
    started_at: float = field(default_factory=time.monotonic)
    status: str = 'running'  # 'running' | 'exited'
    exit_code: int | None = None
    exited_at: float | None = None
    buffer_chunks: deque[str] = field(default_factory=deque)
    buffer_len: int = 0

    @property
    def buffer(self) -> str:
        return ''.join(self.buffer_chunks)

    def elapsed_sec(self) -> int:
        end = self.exited_at if self.exited_at is not None else time.monotonic()
        return max(0, int(end - self.started_at))


_TERMINALS: dict[str, UserPtyTerminalSession] = {}


def user_pty_terminals() -> dict[str, UserPtyTerminalSession]:
    """Live registry of mirrored user PTY sessions (exposed for routes and tests)."""
    _evict_stale_exited()
    return _TERMINALS


def _evict_stale_exited(now: float | None = None) -> None:
    ts = time.monotonic() if now is None else now
    stale = [
        sid
        for sid, term in _TERMINALS.items()
        if term.status != 'running' and term.exited_at is not None and ts - term.exited_at > _EXITED_TTL_SEC
    ]
    for sid in stale:
        _TERMINALS.pop(sid, None)


def _append_buffer(term: UserPtyTerminalSession, chunk: str) -> None:
    if not chunk:
        return
    term.buffer_chunks.append(chunk)
    term.buffer_len += len(chunk)
    overflow = term.buffer_len - _MAX_PTY_CAPTURE_CHARS
    while overflow > 0 and term.buffer_chunks:
        head = term.buffer_chunks[0]
        if len(head) <= overflow:
            term.buffer_chunks.popleft()
            cut = len(head)
        else:
            term.buffer_chunks[0] = head[overflow:]
            cut = overflow
        term.buffer_len -= cut
        overflow -= cut


def register_user_pty_terminal(
    *,
    session_id: str,
    workspace_root: str,
    cwd: str = '',
    shell: str = '',
    pid: int | None = None,
    cols: int = 80,
    rows: int = 24,
) -> UserPtyTerminalSession:
    sid = (session_id or '').strip()
    if not sid:
        raise ValueError('session_id is required')
    _evict_stale_exited()
    root = (workspace_root or '').strip()
    effective_cwd = (cwd or '').strip() or root
    existing = _TERMINALS.get(sid)
    if existing is not None:
        existing.workspace_root = root or existing.workspace_root
        existing.cwd = effective_cwd or existing.cwd
        if shell:
            existing.shell = shell.strip()
        if pid is not None:
            existing.pid = pid
        existing.cols = cols
        existing.rows = rows
        existing.status = 'running'
        existing.exit_code = None
        existing.exited_at = None
        return existing

    term = UserPtyTerminalSession(
        session_id=sid,
        workspace_root=root,
        cwd=effective_cwd,
        shell=(shell or '').strip(),
        pid=pid,
        cols=cols,
        rows=rows,
    )
    _TERMINALS[sid] = term
    return term


def append_user_pty_output(session_id: str, data: str, *, cwd: str = '') -> bool:
    sid = (session_id or '').strip()
    term = _TERMINALS.get(sid)
    if term is None:
        return False
    if cwd.strip():
        term.cwd = cwd.strip()
    _append_buffer(term, data)
    return True


def update_user_pty_cwd(session_id: str, cwd: str) -> bool:
    sid = (session_id or '').strip()
    term = _TERMINALS.get(sid)
    if term is None:
        return False
    if cwd.strip():
        term.cwd = cwd.strip()
    return True


def mark_user_pty_exited(session_id: str, exit_code: int | None = None) -> bool:
    sid = (session_id or '').strip()
    term = _TERMINALS.get(sid)
    if term is None:
        return False
    term.status = 'exited'
    term.exit_code = exit_code
    term.exited_at = time.monotonic()
    return True


def remove_user_pty_terminal(session_id: str) -> bool:
    sid = (session_id or '').strip()
    return _TERMINALS.pop(sid, None) is not None


def clear_all_user_pty_terminals() -> None:
    _TERMINALS.clear()


def _normalize_workspace_key(raw: str) -> str:
    cleaned = (raw or '').strip()
    if not cleaned:
        return ''
    try:
        resolved = str(Path(cleaned).resolve())
    except OSError:
        resolved = os.path.normpath(cleaned)
    normalized = os.path.normcase(os.path.normpath(resolved)).rstrip('\\/')
    return normalized


def _format_cwd_label(workspace_root: str, cwd: str) -> str:
    raw_cwd = (cwd or '').strip()
    raw_root = (workspace_root or '').strip()
    if not raw_cwd:
        return '.'
    if not raw_root:
        return raw_cwd.replace('\\', '/')
    try:
        root_path = Path(raw_root).resolve()
        cwd_path = Path(raw_cwd).resolve()
        rel = cwd_path.relative_to(root_path).as_posix()
        return rel or '.'
    except (ValueError, OSError):
        return raw_cwd.replace('\\', '/')


def clean_terminal_output(raw: str) -> list[str]:
    """Strip ANSI escape sequences and replay carriage-return overwrites into clean lines."""
    if not raw:
        return []
    stripped = _ANSI_ESCAPE_RE.sub('', raw)
    stripped = stripped.replace('\r\n', '\n')
    out_lines: list[str] = []
    for raw_line in stripped.split('\n'):
        if '\r' in raw_line:
            segments = raw_line.split('\r')
            # Keep the last non-empty segment when carriage return overwrote a progress bar/prompt.
            chosen = ''
            for seg in reversed(segments):
                if seg:
                    chosen = seg
                    break
            raw_line = chosen
        # Strip remaining non-printable control chars except tab.
        cleaned = ''.join(ch for ch in raw_line if ch == '\t' or ord(ch) >= 32)
        out_lines.append(clip_line(cleaned.rstrip()))
    while out_lines and not out_lines[-1].strip():
        out_lines.pop()
    return out_lines


def _terminals_for_workspace(workspace_path: str) -> list[UserPtyTerminalSession]:
    _evict_stale_exited()
    all_terms = sorted(_TERMINALS.values(), key=lambda t: t.started_at)
    target_key = _normalize_workspace_key(workspace_path)
    if not target_key:
        return all_terms
    matched = [
        t for t in all_terms if _normalize_workspace_key(t.workspace_root) == target_key
    ]
    return matched if matched else all_terms


@tool(
    CHECK_USER_TERMINALS_NAME,
    description=describe(
        "Check the user's active interactive PTY terminals and recent scrollback output.",
        when="you need to see what terminals the user has open, their current working directory, running dev servers, or recent shell output/errors.",
        not_="agent-started background jobs (use `list_background_commands` / `wait_for_command`) or running new commands (use `run_command`).",
        shape="read-only; optional `terminal_id` filters to one PTY session (e.g. `pty-...`); `tail_lines` caps recent output lines per terminal (default 80, max 500, 0 = metadata only).",
    ),
)
@tool_errors_as_text
def check_user_terminals_tool(
    terminal_id: Annotated[str, 'optional PTY session id (e.g. `pty-...`); empty = all active user terminals'] = '',
    tail_lines: Annotated[int, 'recent output lines to include per terminal (0 = list metadata only, max 500)'] = _DEFAULT_TAIL_LINES,
) -> str:
    sid = (current_session_id.get() or '').strip()
    workspace_path = ''
    if sid:
        session = get_session(sid)
        workspace_path = (session.workspace_path or '').strip()

    safe_tail = max(0, min(int(tail_lines), _MAX_TAIL_LINES))
    terms = _terminals_for_workspace(workspace_path)
    if not terms:
        return 'No active user PTY terminals.'

    requested_id = (terminal_id or '').strip()
    if requested_id:
        matched = [t for t in terms if t.session_id == requested_id]
        if not matched:
            known = ', '.join(f'`{t.session_id}`' for t in terms)
            return f'Tool error: no user terminal with id `{requested_id}`. Active user terminals: {known}.'
        terms = matched

    lines: list[str] = [f'User PTY terminals ({len(terms)}):']
    for idx, term in enumerate(terms, start=1):
        cwd_label = _format_cwd_label(term.workspace_root or workspace_path, term.cwd)
        status_str = (
            f'running ({term.elapsed_sec()}s)'
            if term.status == 'running'
            else f'exited (code {term.exit_code})'
        )
        meta_parts = [f'status: {status_str}', f'cwd: `{cwd_label}`']
        if term.shell:
            shell_name = Path(term.shell.replace('\\', '/')).name or term.shell
            meta_parts.append(f'shell: `{shell_name}`')
        if term.pid is not None:
            meta_parts.append(f'pid: {term.pid}')
        lines.append(f'\n{idx}. `{term.session_id}` — {", ".join(meta_parts)}')

        if safe_tail > 0:
            cleaned_lines = clean_terminal_output(term.buffer)
            if not cleaned_lines:
                lines.append('   Recent output: (empty)')
            else:
                excerpt = cleaned_lines[-safe_tail:]
                omitted = max(0, len(cleaned_lines) - len(excerpt))
                header = f'   Recent output (last {len(excerpt)} line{"s" if len(excerpt) != 1 else ""}'
                if omitted:
                    header += f'; {omitted} earlier lines omitted'
                header += '):'
                lines.append(header)
                for out_line in excerpt:
                    lines.append(f'   │ {out_line}')

    return tool_output_cap('\n'.join(lines) + '\n')
