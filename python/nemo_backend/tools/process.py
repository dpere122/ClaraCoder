"""Host process diagnostics (port search) and HITL process termination."""

from __future__ import annotations

import os
import re
import sys
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any

from langchain_core.tools import tool

from nemo_backend.accept_command import ACCEPT_COMMAND_KIND_PROCESS_KILL
from nemo_backend.domain import SessionState
from nemo_backend.python_env import _run_subprocess_with_output
from nemo_backend.state import current_session_id, get_session
from nemo_backend.tools.tool_conventions import describe
from nemo_backend.tools.workspace import truncate_text_head_tail

SEARCH_NETSTAT_PORTS_NAME = 'search_netstat_ports'
KILL_PROCESS_NAME = 'kill_process'

_MAX_OUTPUT_CHARS = 80_000
_NETSTAT_TIMEOUT_SEC = 20.0
_MAX_ROWS = 200

_PENDING_KILL = 'kill_process'

# Windows: System, System Idle
_PROTECTED_PIDS = frozenset({0, 1, 4}) if sys.platform.startswith('win') else frozenset({0, 1})

_WIN_LISTEN_RE = re.compile(
    r'^\s*(TCP|UDP)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s*$',
    re.I,
)
_SS_LISTEN_RE = re.compile(
    r'^(tcp|udp)\s+LISTEN\s+\d+\s+\d+\s+(\S+)\s+(\S+)\s+.*pid=(\d+)',
    re.I,
)
_NETSTAT_UNIX_RE = re.compile(
    r'^(tcp|udp)\s+\d+\s+\d+\s+(\S+)\s+(\S+)\s+LISTEN\s+(\d+)/\S+',
    re.I,
)

__all__ = [
    'KILL_PROCESS_NAME',
    'SEARCH_NETSTAT_PORTS_NAME',
    'execute_pending_process_kill_request',
    'kill_process_tool',
    'parse_netstat_output',
    'search_listening_ports',
    'search_netstat_ports_tool',
]


@dataclass(frozen=True)
class PortRow:
    protocol: str
    local_address: str
    foreign_address: str
    state: str
    pid: int

    def to_dict(self) -> dict[str, Any]:
        return {
            'protocol': self.protocol,
            'localAddress': self.local_address,
            'foreignAddress': self.foreign_address,
            'state': self.state,
            'pid': self.pid,
        }


def _local_port(local_address: str) -> int | None:
    addr = (local_address or '').strip()
    if not addr:
        return None
    if addr.endswith(':*'):
        port_s = addr.rsplit(':', 1)[0]
        if port_s.startswith('['):
            inner = port_s[1:]
            if ']:' in inner:
                _, _, port_s = inner.rpartition(']:')
            else:
                return None
        else:
            return None
    if ':' not in addr:
        return None
    _, _, port_s = addr.rpartition(':')
    port_s = port_s.rstrip(']').strip()
    if port_s.isdigit():
        value = int(port_s)
        if 1 <= value <= 65535:
            return value
    return None


def _normalize_port(port: object) -> tuple[int | None, str | None]:
    if isinstance(port, bool):
        return None, 'Tool error: `port` must be an integer.'
    if isinstance(port, int):
        value = port
    elif isinstance(port, float) and port.is_integer():
        value = int(port)
    else:
        return None, 'Tool error: `port` must be an integer.'
    if value < 1 or value > 65535:
        return None, 'Tool error: `port` must be between 1 and 65535.'
    return value, None


def _normalize_pid(pid: object) -> tuple[int | None, str | None]:
    if isinstance(pid, bool):
        return None, 'Tool error: `pid` must be a positive integer.'
    if isinstance(pid, int):
        value = pid
    elif isinstance(pid, float) and pid.is_integer():
        value = int(pid)
    else:
        return None, 'Tool error: `pid` must be a positive integer.'
    if value < 1:
        return None, 'Tool error: `pid` must be a positive integer.'
    return value, None


def parse_netstat_output(text: str, *, platform: str | None = None) -> list[PortRow]:
    """Parse ``netstat`` or ``ss`` output into listening-socket rows."""

    plat = (platform or sys.platform).lower()
    rows: list[PortRow] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.lower().startswith(('active', 'proto', 'conn')):
            continue
        if plat.startswith('win'):
            match = _WIN_LISTEN_RE.match(line)
            if not match:
                continue
            proto, local, foreign, state, pid_s = match.groups()
            if state.upper() != 'LISTENING' and proto.upper() == 'TCP':
                continue
            try:
                pid = int(pid_s)
            except ValueError:
                continue
            rows.append(
                PortRow(
                    protocol=proto.upper(),
                    local_address=local,
                    foreign_address=foreign,
                    state=state.upper(),
                    pid=pid,
                )
            )
            continue
        ss_match = _SS_LISTEN_RE.match(stripped)
        if ss_match:
            proto, local, foreign, pid_s = ss_match.groups()
            try:
                pid = int(pid_s)
            except ValueError:
                continue
            rows.append(
                PortRow(
                    protocol=proto.upper(),
                    local_address=local,
                    foreign_address=foreign,
                    state='LISTEN',
                    pid=pid,
                )
            )
            continue
        unix_match = _NETSTAT_UNIX_RE.match(stripped)
        if unix_match:
            proto, local, foreign, pid_s = unix_match.groups()
            try:
                pid = int(pid_s)
            except ValueError:
                continue
            rows.append(
                PortRow(
                    protocol=proto.upper(),
                    local_address=local,
                    foreign_address=foreign,
                    state='LISTEN',
                    pid=pid,
                )
            )
    return rows


def _filter_rows(
    rows: list[PortRow],
    *,
    port: int | None,
    local_address_contains: str,
) -> list[PortRow]:
    needle = (local_address_contains or '').strip().lower()
    out: list[PortRow] = []
    for row in rows:
        if port is not None and _local_port(row.local_address) != port:
            continue
        if needle and needle not in row.local_address.lower():
            continue
        out.append(row)
    return out[:_MAX_ROWS]


async def _run_netstat() -> tuple[int | None, str]:
    if sys.platform.startswith('win'):
        return await _run_subprocess_with_output(
            ['netstat', '-ano'],
            cwd=Path.cwd(),
            timeout_sec=_NETSTAT_TIMEOUT_SEC,
        )
    code, output = await _run_subprocess_with_output(
        ['ss', '-H', '-tulpn'],
        cwd=Path.cwd(),
        timeout_sec=_NETSTAT_TIMEOUT_SEC,
    )
    if code == 0:
        return code, output
    fallback = ['netstat', '-anv'] if sys.platform == 'darwin' else ['netstat', '-tulpn']
    return await _run_subprocess_with_output(
        fallback,
        cwd=Path.cwd(),
        timeout_sec=_NETSTAT_TIMEOUT_SEC,
    )


def search_listening_ports(
    raw_output: str,
    *,
    port: int | None = None,
    local_address_contains: str = '',
    platform: str | None = None,
) -> list[PortRow]:
    rows = parse_netstat_output(raw_output, platform=platform)
    listen_rows = [r for r in rows if r.state in ('LISTENING', 'LISTEN')]
    return _filter_rows(listen_rows, port=port, local_address_contains=local_address_contains)


def _format_port_report(
    *,
    port: int | None,
    local_address_contains: str,
    rows: list[PortRow],
    command_text: str,
    exit_code: int | None,
    stderr_note: str = '',
) -> str:
    lines = [
        'Listening port search:',
        f'- Command: `{command_text}`',
        f'- Exit code: {exit_code if exit_code is not None else "unknown"}',
    ]
    if port is not None:
        lines.append(f'- Filter port: `{port}`')
    if local_address_contains.strip():
        lines.append(f'- Filter local address contains: `{local_address_contains.strip()}`')
    lines.append(f'- Matches: {len(rows)}')
    if stderr_note.strip():
        lines.append(f'- Note: {stderr_note.strip()}')
    lines.append('')
    if not rows:
        lines.append('No matching listening sockets found.')
    else:
        for index, row in enumerate(rows, start=1):
            local_port = _local_port(row.local_address)
            port_label = f' (port {local_port})' if local_port is not None else ''
            lines.append(
                f'{index}. `{row.protocol}` `{row.local_address}`{port_label} — '
                f'pid `{row.pid}` ({row.state})'
            )
            if row.foreign_address and row.foreign_address not in ('*:*', '0.0.0.0:0'):
                lines.append(f'   Foreign: `{row.foreign_address}`')
        lines.append('')
        lines.append('Use `kill_process` with a pid from this list to free a port (requires user confirmation).')
    body = '\n'.join(lines) + '\n'
    if len(body) <= _MAX_OUTPUT_CHARS:
        return body
    return truncate_text_head_tail(body, _MAX_OUTPUT_CHARS)


@tool(SEARCH_NETSTAT_PORTS_NAME, description=describe('List listening TCP/UDP sockets on the host (`netstat` / `ss`).',
        when='diagnosing port conflicts (e.g. EADDRINUSE) before smoke tests or dev servers.',
        not_='killing processes (use `kill_process` after identifying a PID).',
        shape='read-only; optional filter by port or local address substring; returns PIDs for `kill_process`.',))
async def search_netstat_ports_tool(
    port: Annotated[int | None, '1-65535 TCP/UDP port'] = None,
    local_address_contains: str = '',
) -> str:

    port_value: int | None = None
    if port is not None:
        port_value, port_err = _normalize_port(port)
        if port_err:
            return port_err

    code, output = await _run_netstat()
    if code is None:
        return f'Tool error: could not run port listing command.\n\n{output.strip()}'
    rows = search_listening_ports(
        output,
        port=port_value,
        local_address_contains=local_address_contains,
    )
    cmd = 'netstat -ano' if sys.platform.startswith('win') else 'ss -H -tulpn (or netstat)'
    note = ''
    if code != 0 and rows:
        note = 'command exited non-zero but partial output was parsed'
    elif code != 0:
        return f'Tool error: port listing failed (exit {code}).\n\n{output.strip() or "(no output)"}'
    return _format_port_report(
        port=port_value,
        local_address_contains=local_address_contains,
        rows=rows,
        command_text=cmd,
        exit_code=code,
        stderr_note=note,
    )


def _kill_command_text(*, pid: int, force: bool, kill_tree: bool) -> str:
    if sys.platform.startswith('win'):
        parts = ['taskkill', '/PID', str(pid)]
        if kill_tree:
            parts.append('/T')
        if force:
            parts.append('/F')
        return ' '.join(parts)
    signal_name = 'SIGKILL' if force else 'SIGTERM'
    return f'kill -{9 if force else 15} {pid}  # {signal_name}'


async def _execute_kill(*, pid: int, force: bool, kill_tree: bool) -> str:
    if pid in _PROTECTED_PIDS or pid == os.getpid():
        return f'Tool error: refusing to kill protected pid `{pid}`.'

    if sys.platform.startswith('win'):
        args = ['taskkill', '/PID', str(pid)]
        if kill_tree:
            args.append('/T')
        if force:
            args.append('/F')
        code, output = await _run_subprocess_with_output(args, cwd=Path.cwd(), timeout_sec=30.0)
        cmd = ' '.join(args)
        if code == 0:
            return f'Process kill summary:\n- Command: `{cmd}`\n- Result: success\n\n{output.strip() or "(no output)"}'
        return f'Tool error: kill failed (exit {code}).\n\n- Command: `{cmd}`\n\n{output.strip() or "(no output)"}'

    import signal

    try:
        os.kill(pid, signal.SIGKILL if force else signal.SIGTERM)
    except ProcessLookupError:
        return f'Tool error: no process with pid `{pid}`.'
    except PermissionError:
        return f'Tool error: permission denied killing pid `{pid}`.'
    except OSError as exc:
        return f'Tool error: could not kill pid `{pid}` ({exc}).'
    return (
        f'Process kill summary:\n'
        f'- Signal: `{"SIGKILL" if force else "SIGTERM"}`\n'
        f'- PID: `{pid}`\n'
        f'- Result: signal sent (exit status not available on this platform)\n'
    )


def _pending_kill_command(
    session: SessionState,
    *,
    pid: int,
    force: bool,
    kill_tree: bool,
) -> str:
    command_text = _kill_command_text(pid=pid, force=force, kill_tree=kill_tree)
    session.pending_accept_command_request = {
        'request_id': uuid.uuid4().hex,
        'kind': ACCEPT_COMMAND_KIND_PROCESS_KILL,
        'title': 'Kill process',
        'message': f'Terminate process `{pid}` on this machine?',
        'confirm_label': 'Kill process',
        'cancel_label': 'Cancel',
        'command_text': command_text,
        'details': [
            f'PID: `{pid}`',
            f'Force: {force}',
            f'Kill child processes (Windows /T): {kill_tree}',
        ],
        'cancel_note': f'User cancelled killing process `{pid}`.',
        'action': {
            'kind': _PENDING_KILL,
            'pid': pid,
            'force': force,
            'kill_tree': kill_tree,
        },
    }
    return (
        f'Pending user confirmation to kill process `{pid}`. '
        'The UI will ask before `taskkill` / `kill` runs.'
    )


async def execute_pending_process_kill_request(session: SessionState, pending: dict) -> str:
    action = pending.get('action') if isinstance(pending.get('action'), dict) else {}
    if str(action.get('kind') or '') != _PENDING_KILL:
        return f'Tool error: unsupported pending kill action `{action.get("kind") or "unknown"}`.'
    pid, err = _normalize_pid(action.get('pid'))
    if err:
        return err
    assert pid is not None
    return await _execute_kill(
        pid=pid,
        force=bool(action.get('force')),
        kill_tree=bool(action.get('kill_tree', True)),
    )


@tool(KILL_PROCESS_NAME, description=describe('Kill a host process by PID.',
        when='freeing a port or stopping a stuck process after `search_netstat_ports`.',
        not_='graceful app shutdown inside the workspace (prefer stopping dev servers normally).',
        shape=(
            'always requires user confirmation; Windows `taskkill` (`/T` when `kill_tree`); '
            'refuses protected system PIDs.'
        ),))
async def kill_process_tool(
    pid: Annotated[int, 'host process id from search_netstat_ports'],
    force: bool = True,
    kill_tree: bool = True,
) -> str:

    sid = (current_session_id.get() or '').strip()
    if not sid:
        return 'Tool error: no active session.'
    session = get_session(sid)

    pid_value, pid_err = _normalize_pid(pid)
    if pid_err:
        return pid_err
    assert pid_value is not None

    if pid_value in _PROTECTED_PIDS or pid_value == os.getpid():
        return f'Tool error: refusing to kill protected pid `{pid_value}`.'

    # Always HITL for kills (even when auto-apply is on).
    return _pending_kill_command(session, pid=pid_value, force=bool(force), kill_tree=bool(kill_tree))
