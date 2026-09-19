"""Privileged localhost broker that runs approved shell commands.

Launched via UAC (Windows ``runas``) or polkit (``pkexec``) so the Clara sidecar
can stream output without elevating Electron. Uses JSON-lines over 127.0.0.1.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hmac
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

_READ_BLOCK = 65_536


def tokens_match(got: str, expected: str) -> bool:
    """Constant-time token compare; different lengths never match."""

    a = (got or '').encode('utf-8')
    b = (expected or '').encode('utf-8')
    if len(a) != len(b):
        return False
    return hmac.compare_digest(a, b)


def _json_line(payload: dict[str, Any]) -> bytes:
    return (json.dumps(payload, separators=(',', ':')) + '\n').encode('utf-8')


async def _terminate_tree(proc: asyncio.subprocess.Process) -> None:
    if proc.returncode is not None:
        return
    pid = proc.pid
    if not isinstance(pid, int) or pid <= 0:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        return
    if sys.platform.startswith('win'):

        def _win_kill() -> None:
            flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
            try:
                subprocess.run(
                    ['taskkill', '/PID', str(pid), '/T', '/F'],
                    capture_output=True,
                    timeout=25,
                    creationflags=flags,
                )
            except (FileNotFoundError, OSError, subprocess.SubprocessError):
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass

        await asyncio.to_thread(_win_kill)
    else:
        try:
            os.killpg(pid, 9)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                proc.kill()
            except ProcessLookupError:
                pass
    try:
        await asyncio.wait_for(proc.wait(), timeout=12.0)
    except (asyncio.TimeoutError, ProcessLookupError):
        pass


#: Exit if the sidecar never authenticates (it connects within ~100ms of the port file appearing).
_IDLE_EXIT_SEC = 60.0


class _Broker:
    """One elevated helper serving exactly one authenticated sidecar connection.

    The unelevated sidecar cannot kill this process, so the broker must exit on
    its own: after a ``shutdown`` op, when the authenticated client disconnects,
    or when nobody authenticates within ``_IDLE_EXIT_SEC``.
    """

    def __init__(self, token: str) -> None:
        self.token = token
        self.jobs: dict[str, asyncio.subprocess.Process] = {}
        self._closing = False
        self._authenticated = False
        #: Serialize writes: ``_pump`` tasks and the serve loop share one writer,
        #: and concurrent ``drain()`` under backpressure asserts on Python < 3.12.
        self._write_lock = asyncio.Lock()
        self.done = asyncio.Event()

    @property
    def is_authenticated(self) -> bool:
        return self._authenticated

    async def _send(self, writer: asyncio.StreamWriter, payload: dict[str, Any]) -> None:
        async with self._write_lock:
            writer.write(_json_line(payload))
            await writer.drain()

    async def serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        authenticated_here = False
        try:
            hello = await self._read_msg(reader)
            if hello is None:
                return
            if (
                self._authenticated
                or self._closing
                or hello.get('op') != 'hello'
                or not tokens_match(str(hello.get('token') or ''), self.token)
            ):
                await self._send(writer, {'op': 'hello_err', 'error': 'invalid token'})
                return
            self._authenticated = True
            authenticated_here = True
            await self._send(writer, {'op': 'hello_ok'})
            while not self._closing:
                msg = await self._read_msg(reader)
                if msg is None:
                    break
                op = str(msg.get('op') or '')
                if op == 'run':
                    await self._handle_run(msg, writer)
                elif op == 'kill':
                    await self._handle_kill(msg, writer)
                elif op == 'shutdown':
                    self._closing = True
                    await self._kill_all()
                    await self._send(writer, {'op': 'bye'})
                    break
                else:
                    await self._send(writer, {'op': 'error', 'error': f'unknown op `{op}`'})
        except (ConnectionError, OSError):
            pass
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except (ConnectionError, OSError):
                pass
            if authenticated_here:
                # The sidecar is gone (clean shutdown or crash): nothing else may
                # ever drive this helper, so tear down the jobs and exit.
                self._closing = True
                await self._kill_all()
                self.done.set()

    async def _read_msg(self, reader: asyncio.StreamReader) -> dict[str, Any] | None:
        raw = await reader.readline()
        if not raw:
            return None
        try:
            parsed = json.loads(raw.decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        return parsed if isinstance(parsed, dict) else None

    async def _handle_run(self, msg: dict[str, Any], writer: asyncio.StreamWriter) -> None:
        job_id = str(msg.get('job_id') or '').strip()
        command = str(msg.get('command') or '')
        cwd = str(msg.get('cwd') or '') or None
        env_raw = msg.get('env')
        env: dict[str, str] | None = None
        if isinstance(env_raw, dict):
            env = {str(k): str(v) for k, v in env_raw.items() if v is not None}
        if not job_id or not command.strip():
            await self._send(writer, {'op': 'run_err', 'job_id': job_id, 'error': 'missing job_id or command'})
            return
        if job_id in self.jobs:
            await self._send(writer, {'op': 'run_err', 'job_id': job_id, 'error': 'duplicate job_id'})
            return
        try:
            proc = await asyncio.create_subprocess_shell(
                command,
                cwd=cwd,
                env=env,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                start_new_session=True,
            )
        except OSError as exc:
            await self._send(writer, {'op': 'run_err', 'job_id': job_id, 'error': str(exc)})
            return
        self.jobs[job_id] = proc
        asyncio.create_task(self._pump(job_id, proc, writer))

    async def _pump(
        self,
        job_id: str,
        proc: asyncio.subprocess.Process,
        writer: asyncio.StreamWriter,
    ) -> None:
        stdout = proc.stdout
        try:
            if stdout is not None:
                while True:
                    block = await stdout.read(_READ_BLOCK)
                    if not block:
                        break
                    await self._send(
                        writer,
                        {'op': 'data', 'job_id': job_id, 'b64': base64.b64encode(block).decode('ascii')},
                    )
        except (ConnectionError, OSError):
            await _terminate_tree(proc)
            return
        finally:
            code = await proc.wait()
            self.jobs.pop(job_id, None)
            try:
                await self._send(writer, {'op': 'exit', 'job_id': job_id, 'code': int(code if code is not None else 1)})
            except (ConnectionError, OSError):
                pass

    async def _handle_kill(self, msg: dict[str, Any], writer: asyncio.StreamWriter) -> None:
        job_id = str(msg.get('job_id') or '').strip()
        proc = self.jobs.get(job_id)
        if proc is None:
            await self._send(writer, {'op': 'killed', 'job_id': job_id, 'ok': False})
            return
        await _terminate_tree(proc)
        await self._send(writer, {'op': 'killed', 'job_id': job_id, 'ok': True})

    async def _kill_all(self) -> None:
        for proc in list(self.jobs.values()):
            await _terminate_tree(proc)
        self.jobs.clear()


def _unlink_quiet(path: Path | None) -> None:
    if path is None:
        return
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


async def _async_main(token: str, port_file: Path, config_path: Path | None) -> int:
    broker = _Broker(token)
    server = await asyncio.start_server(broker.serve, host='127.0.0.1', port=0)
    sockets = server.sockets or []
    if not sockets:
        return 1
    port = int(sockets[0].getsockname()[1])
    payload = json.dumps({'port': port, 'pid': os.getpid()}, separators=(',', ':'))
    tmp = port_file.with_suffix(port_file.suffix + '.tmp')
    tmp.write_text(payload, encoding='utf-8')
    tmp.replace(port_file)
    try:
        async with server:
            try:
                await asyncio.wait_for(broker.done.wait(), timeout=_IDLE_EXIT_SEC)
            except asyncio.TimeoutError:
                # Idle exit unless the sidecar authenticated in time; then stay
                # up until that connection ends (shutdown op or sidecar crash).
                if broker.is_authenticated:
                    await broker.done.wait()
            await broker._kill_all()
    finally:
        # These live in the user's temp dir but may be owned by this elevated
        # process (Linux sticky /tmp), so clean them up from here.
        _unlink_quiet(port_file)
        _unlink_quiet(config_path)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='Clara elevated command broker')
    parser.add_argument('--config', required=True, help='JSON file with {"token": "..."}')
    parser.add_argument('--port-file', required=True, help='Written with {"port": N, "pid": N} after bind')
    args = parser.parse_args(argv)
    config_path = Path(args.config)
    port_file = Path(args.port_file)
    try:
        raw = json.loads(config_path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as exc:
        sys.stderr.write(f'admin_broker: failed to read config: {exc}\n')
        return 2
    token = str((raw or {}).get('token') or '').strip()
    if not token:
        sys.stderr.write('admin_broker: config is missing token\n')
        return 2
    python_path = (raw or {}).get('python_path')
    if isinstance(python_path, list):
        for entry in python_path:
            text = str(entry).strip()
            if text and text not in sys.path:
                sys.path.insert(0, text)
    # The token has been read; do not leave it on disk for other same-user
    # processes to pick up while this elevated helper is alive.
    _unlink_quiet(config_path)
    try:
        return asyncio.run(_async_main(token, port_file, config_path))
    except KeyboardInterrupt:
        return 0


if __name__ == '__main__':
    raise SystemExit(main())
