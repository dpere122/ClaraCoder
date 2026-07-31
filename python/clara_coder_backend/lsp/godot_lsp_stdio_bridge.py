"""Bridge LSP JSON-RPC over stdio to Godot's TCP language server (default ``127.0.0.1:6005``).

Godot serves GDScript LSP on a TCP port while the editor is running with the project open
(see Editor Settings → Network → Language Server). Nemo's LSP client only speaks stdio to a
subprocess, so this script proxies ``Content-Length`` framed messages between stdin/stdout and
that socket.

Environment (optional):

- ``CLARA_GODOT_LSP_HOST`` — default ``127.0.0.1``
- ``CLARA_GODOT_LSP_PORT`` — default ``6005``

Override the whole argv with ``CLARA_GDSCRIPT_LSP_COMMAND`` on :class:`~clara_coder_backend.lsp.plugins.gdscript_plugin.GdscriptLspPlugin` instead of using this bridge.
"""

from __future__ import annotations

from clara_coder_backend.session.config import env_clara

import os
import socket
import sys
import threading
from typing import BinaryIO


def _read_headers(stream: BinaryIO) -> dict[str, str] | None:
    headers: dict[str, str] = {}
    while True:
        raw = stream.readline()
        if not raw:
            return None
        if raw in (b'\r\n', b'\n'):
            return headers
        line = raw.decode('ascii', errors='replace').strip()
        if not line or ':' not in line:
            continue
        name, value = line.split(':', 1)
        headers[name.strip()] = value.strip()


def _read_exact(stream: BinaryIO, n: int) -> bytes:
    if n <= 0:
        return b''
    parts: list[bytes] = []
    remaining = n
    while remaining > 0:
        chunk = stream.read(remaining)
        if not chunk:
            break
        parts.append(chunk)
        remaining -= len(chunk)
    return b''.join(parts)


def _read_one_message(stream: BinaryIO) -> bytes | None:
    headers = _read_headers(stream)
    if headers is None:
        return None
    length_raw = headers.get('content-length') or headers.get('Content-Length')
    if not length_raw:
        return b''
    try:
        length = int(length_raw)
    except ValueError:
        return b''
    if length < 0:
        return b''
    return _read_exact(stream, length)


def _write_message(stream: BinaryIO, body: bytes) -> None:
    header = f'Content-Length: {len(body)}\r\n\r\n'.encode('ascii')
    stream.write(header + body)
    stream.flush()


def _forward(name: str, src: BinaryIO, dst: BinaryIO, on_eof_close: socket.socket | None = None) -> None:
    del name  # reserved for debugging
    try:
        while True:
            body = _read_one_message(src)
            if body is None:
                break
            _write_message(dst, body)
    except BrokenPipeError:
        pass
    except OSError:
        pass
    finally:
        if on_eof_close is not None:
            try:
                on_eof_close.shutdown(socket.SHUT_WR)
            except OSError:
                pass


def main() -> None:
    host = (env_clara('CLARA_GODOT_LSP_HOST') or '127.0.0.1').strip()
    raw_port = (env_clara('CLARA_GODOT_LSP_PORT') or '6005').strip()
    try:
        port = int(raw_port)
    except ValueError:
        port = 6005
    try:
        sock = socket.create_connection((host, port), timeout=10.0)
    except OSError as exc:
        sys.stderr.write(
            f'godot-lsp-bridge: could not connect to Godot LSP at {host}:{port} ({exc}).\n'
            'Open this project in the Godot editor (Language Server enabled, default port 6005), '
            'or set CLARA_GODOT_LSP_HOST / CLARA_GODOT_LSP_PORT, or set CLARA_GDSCRIPT_LSP_COMMAND to a custom stdio server.\n'
        )
        sys.stderr.flush()
        raise SystemExit(1) from exc
    sock.settimeout(None)
    sock_file = sock.makefile('rwb', buffering=0)

    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer
    out_lock = threading.Lock()

    def socket_to_stdout() -> None:
        try:
            while True:
                body = _read_one_message(sock_file)
                if body is None:
                    break
                with out_lock:
                    _write_message(stdout, body)
        except BrokenPipeError:
            pass
        except OSError:
            pass

    t_out = threading.Thread(target=socket_to_stdout, name='godot-lsp-socket', daemon=True)
    t_out.start()

    try:
        _forward('stdin->socket', stdin, sock_file, sock)
    finally:
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            sock.close()
        except OSError:
            pass
    t_out.join(timeout=3.0)
    raise SystemExit(0)


if __name__ == '__main__':
    main()
