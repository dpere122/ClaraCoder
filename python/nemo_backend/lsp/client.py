"""Minimal synchronous JSON-RPC client for subprocess-backed language servers."""

from __future__ import annotations

import json
import logging
import queue
import subprocess
import threading
from collections import deque
from collections.abc import Callable
from pathlib import Path
from typing import Any

logger = logging.getLogger('nemo.lsp.protocol')

NotificationHandler = Callable[[str, dict[str, Any]], None]

__all__ = ['JsonRpcLspClient']


class JsonRpcLspClient:
    """A small blocking LSP client suitable for tool-call workloads."""

    def __init__(
        self,
        command: list[str],
        *,
        workspace_root: Path,
        notification_handler: NotificationHandler | None = None,
        startup_timeout_s: float = 20.0,
    ) -> None:
        self._command = list(command)
        self._workspace_root = Path(workspace_root).resolve()
        self._notification_handler = notification_handler
        self._startup_timeout_s = max(1.0, float(startup_timeout_s))
        self._proc: subprocess.Popen[bytes] | None = None
        self._lock = threading.RLock()
        self._write_lock = threading.Lock()
        self._reader_thread: threading.Thread | None = None
        self._stderr_thread: threading.Thread | None = None
        self._pending: dict[int, queue.Queue[dict[str, Any]]] = {}
        self._next_id = 0
        self._closed = False
        self._initialized = False
        self._stderr_tail: deque[str] = deque(maxlen=10)

    def start(self) -> None:
        with self._lock:
            if self._proc is not None:
                return
            logger.info('lsp subprocess start workspace=%s command=%s', self._workspace_root, self._command)
            self._proc = subprocess.Popen(
                self._command,
                cwd=str(self._workspace_root),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                bufsize=0,
            )
            self._reader_thread = threading.Thread(target=self._read_stdout_loop, name='nemo-lsp-stdout', daemon=True)
            self._reader_thread.start()
            self._stderr_thread = threading.Thread(target=self._read_stderr_loop, name='nemo-lsp-stderr', daemon=True)
            self._stderr_thread.start()

    def initialize(
        self,
        *,
        root_uri: str,
        process_id: int | None,
        capabilities: dict[str, Any],
        initialization_options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        self.start()
        result = self.request(
            'initialize',
            {
                'processId': process_id,
                'clientInfo': {'name': 'nemo-wrapper', 'version': '0.1.0'},
                'rootUri': root_uri,
                'workspaceFolders': [{'uri': root_uri, 'name': self._workspace_root.name}],
                'capabilities': capabilities,
                'initializationOptions': dict(initialization_options or {}),
                'trace': 'off',
            },
            timeout_s=self._startup_timeout_s,
        )
        self.notify('initialized', {})
        self._initialized = True
        logger.info('lsp initialize complete workspace=%s', self._workspace_root)
        return result

    def request(self, method: str, params: dict[str, Any], *, timeout_s: float = 10.0) -> dict[str, Any]:
        with self._lock:
            proc = self._require_process()
            self._next_id += 1
            req_id = self._next_id
            wait_q: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=1)
            self._pending[req_id] = wait_q
        try:
            self._send_message({'jsonrpc': '2.0', 'id': req_id, 'method': method, 'params': params})
        except Exception:
            with self._lock:
                self._pending.pop(req_id, None)
            raise
        try:
            response = wait_q.get(timeout=max(0.1, timeout_s))
        except queue.Empty as exc:
            with self._lock:
                self._pending.pop(req_id, None)
            proc_state = proc.poll()
            raise TimeoutError(
                f'LSP request timed out for {method!r} after {timeout_s:.1f}s (process={proc_state}).'
            ) from exc
        if 'error' in response:
            error = response.get('error') or {}
            raise RuntimeError(
                f"LSP request failed for {method!r}: {error.get('message') or 'unknown error'}"
            )
        # Preserve JSON ``null`` results (e.g. ``textDocument/rename`` unsupported).
        return response.get('result')

    def notify(self, method: str, params: dict[str, Any]) -> None:
        self._send_message({'jsonrpc': '2.0', 'method': method, 'params': params})

    def shutdown(self) -> None:
        with self._lock:
            proc = self._proc
            if proc is None or self._closed:
                return
        if self._initialized:
            try:
                self.request('shutdown', {}, timeout_s=5.0)
            except Exception as exc:
                logger.warning('lsp shutdown request failed workspace=%s err=%s', self._workspace_root, exc)
        try:
            self.notify('exit', {})
        except Exception:
            pass
        self.close()

    def close(self) -> None:
        with self._lock:
            proc = self._proc
            if proc is None or self._closed:
                return
            self._closed = True
            exit_code = proc.poll()
        try:
            if proc.stdin is not None:
                proc.stdin.close()
        except Exception:
            pass
        try:
            proc.wait(timeout=2.0)
        except Exception:
            proc.kill()
        exit_code = proc.poll()
        with self._lock:
            self._proc = None
            pending = list(self._pending.values())
            self._pending.clear()
            stderr_summary = self._stderr_summary_locked()
        error_payload = {
            'error': {
                'message': self._format_closed_message(
                    exit_code=exit_code,
                    stderr_summary=stderr_summary,
                )
            }
        }
        for wait_q in pending:
            try:
                wait_q.put_nowait(error_payload)
            except queue.Full:
                pass
        logger.info(
            'lsp subprocess closed workspace=%s exit_code=%s stderr=%s',
            self._workspace_root,
            exit_code,
            stderr_summary or '(none)',
        )

    def _require_process(self) -> subprocess.Popen[bytes]:
        proc = self._proc
        if proc is None:
            raise RuntimeError('LSP subprocess is not running.')
        return proc

    def _send_message(self, payload: dict[str, Any]) -> None:
        raw = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        msg = f'Content-Length: {len(raw)}\r\n\r\n'.encode('ascii') + raw
        proc = self._require_process()
        if proc.stdin is None:
            raise RuntimeError('LSP subprocess stdin is unavailable.')
        try:
            with self._write_lock:
                proc.stdin.write(msg)
                proc.stdin.flush()
        except OSError as exc:
            with self._lock:
                exit_code = proc.poll()
                stderr_summary = self._stderr_summary_locked()
            self.close()
            raise RuntimeError(
                self._format_closed_message(exit_code=exit_code, stderr_summary=stderr_summary)
            ) from exc

    def _read_stderr_loop(self) -> None:
        proc = self._proc
        if proc is None or proc.stderr is None:
            return
        try:
            for line in iter(proc.stderr.readline, b''):
                text = line.decode('utf-8', errors='replace').rstrip()
                if text:
                    with self._lock:
                        self._stderr_tail.append(text)
                    logger.warning('lsp stderr workspace=%s %s', self._workspace_root, text)
        except Exception as exc:
            logger.debug('lsp stderr loop ended workspace=%s err=%s', self._workspace_root, exc)

    def _read_stdout_loop(self) -> None:
        proc = self._proc
        if proc is None or proc.stdout is None:
            return
        try:
            while True:
                headers = self._read_headers(proc.stdout)
                if headers is None:
                    break
                length_raw = headers.get('content-length') or headers.get('Content-Length')
                if not length_raw:
                    continue
                try:
                    length = int(length_raw)
                except ValueError:
                    logger.warning('lsp bad content-length workspace=%s value=%s', self._workspace_root, length_raw)
                    continue
                body = proc.stdout.read(length)
                if not body:
                    break
                self._handle_message(json.loads(body.decode('utf-8', errors='replace')))
        except Exception as exc:
            logger.warning('lsp stdout loop failed workspace=%s err=%s', self._workspace_root, exc)
        finally:
            self.close()

    def _read_headers(self, stdout: Any) -> dict[str, str] | None:
        headers: dict[str, str] = {}
        while True:
            raw = stdout.readline()
            if not raw:
                return None
            if raw in (b'\r\n', b'\n'):
                return headers
            line = raw.decode('ascii', errors='replace').strip()
            if not line or ':' not in line:
                continue
            name, value = line.split(':', 1)
            headers[name.strip()] = value.strip()

    def _handle_message(self, payload: dict[str, Any]) -> None:
        msg_id = payload.get('id')
        if msg_id is not None and 'method' in payload:
            self._reply_to_server_request(payload)
            return
        if msg_id is not None:
            req_id = int(msg_id)
            with self._lock:
                wait_q = self._pending.pop(req_id, None)
            if wait_q is not None:
                wait_q.put(payload)
            return
        method = str(payload.get('method') or '')
        params = payload.get('params')
        if method and isinstance(params, dict) and self._notification_handler is not None:
            try:
                self._notification_handler(method, params)
            except Exception as exc:
                logger.warning('lsp notification handler failed workspace=%s method=%s err=%s', self._workspace_root, method, exc)

    def _reply_to_server_request(self, payload: dict[str, Any]) -> None:
        """Answer server-initiated JSON-RPC requests so the language server does not hang."""

        req_id = payload.get('id')
        method = str(payload.get('method') or '')
        if req_id is None:
            return
        result: Any = None
        if method == 'workspace/semanticTokens/refresh':
            result = None
        else:
            logger.debug('lsp unhandled server request workspace=%s method=%s', self._workspace_root, method)
        try:
            self._send_message({'jsonrpc': '2.0', 'id': req_id, 'result': result})
        except Exception as exc:
            logger.warning(
                'lsp failed to reply to server request workspace=%s method=%s err=%s',
                self._workspace_root,
                method,
                exc,
            )

    def _stderr_summary_locked(self) -> str:
        summary = ' | '.join(self._stderr_tail)
        if len(summary) > 400:
            return '...' + summary[-397:]
        return summary

    @staticmethod
    def _format_closed_message(*, exit_code: int | None, stderr_summary: str) -> str:
        parts = ['LSP client closed']
        if exit_code is not None:
            parts.append(f'exit_code={exit_code}')
        if stderr_summary:
            parts.append(f'stderr={stderr_summary}')
        return f"{parts[0]} ({', '.join(parts[1:])})" if len(parts) > 1 else parts[0]
