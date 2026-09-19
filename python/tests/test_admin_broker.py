"""Elevated broker protocol tests (no UAC / pkexec)."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

from clara_coder_backend.hitl.accept_command import accept_command_sse_payload
from clara_coder_backend.runtime.admin_broker import tokens_match
from unittest.mock import AsyncMock, patch

from clara_coder_backend.runtime import admin_exec
from clara_coder_backend.runtime.admin_exec import (
    ensure_session_broker,
    python_package_root,
    warmup_persistent_broker,
)


async def _spawn_broker(tmp_path: Path, token: str) -> tuple[asyncio.subprocess.Process, Path, Path]:
    config = tmp_path / 'cfg.json'
    port_file = tmp_path / 'port.json'
    config.write_text(json.dumps({'token': token, 'python_path': [str(python_package_root())]}), encoding='utf-8')
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        '-m',
        'clara_coder_backend.runtime.admin_broker',
        '--config',
        str(config),
        '--port-file',
        str(port_file),
        cwd=str(python_package_root()),
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    return proc, config, port_file


async def _hello(port: int, token: str) -> tuple[asyncio.StreamReader, asyncio.StreamWriter, dict]:
    reader, writer = await asyncio.open_connection('127.0.0.1', port)
    writer.write((json.dumps({'op': 'hello', 'token': token}) + '\n').encode('utf-8'))
    await writer.drain()
    reply = json.loads((await asyncio.wait_for(reader.readline(), timeout=10.0)).decode('utf-8'))
    return reader, writer, reply


def test_tokens_match_rejects_wrong_or_empty() -> None:
    token = 'a' * 32
    assert tokens_match(token, token) is True
    assert tokens_match('b' * 32, token) is False
    assert tokens_match('', token) is False
    assert tokens_match(token, '') is False
    assert tokens_match('short', token) is False


def test_accept_command_sse_payload_includes_session_label() -> None:
    payload = accept_command_sse_payload(
        {
            'request_id': 'r1',
            'kind': 'deferred_tool',
            'title': 'Run administrator command',
            'message': 'm',
            'confirm_label': 'Allow once',
            'confirm_session_label': 'Allow for this session',
            'cancel_label': 'Cancel',
            'command_text': 'apt update',
            'details': ['Elevation: `administrator`'],
        }
    )
    assert payload['confirmSessionLabel'] == 'Allow for this session'
    assert payload['confirmLabel'] == 'Allow once'


async def _wait_port_file(path: Path, timeout: float = 10.0) -> int:
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        if path.is_file():
            try:
                data = json.loads(path.read_text(encoding='utf-8'))
                return int(data['port'])
            except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
                pass
        await asyncio.sleep(0.05)
    raise AssertionError(f'broker port file was not written: {path}')


@pytest.mark.asyncio(loop_scope='function')
async def test_broker_rejects_bad_token(tmp_path: Path) -> None:
    token = 'c' * 64
    config = tmp_path / 'cfg.json'
    port_file = tmp_path / 'port.json'
    config.write_text(json.dumps({'token': token, 'python_path': [str(python_package_root())]}), encoding='utf-8')
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        '-m',
        'clara_coder_backend.runtime.admin_broker',
        '--config',
        str(config),
        '--port-file',
        str(port_file),
        cwd=str(python_package_root()),
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        port = await _wait_port_file(port_file)
        reader, writer = await asyncio.open_connection('127.0.0.1', port)
        writer.write(b'{"op":"hello","token":"definitely-not-the-token-value-0000"}\n')
        await writer.drain()
        reply = json.loads((await reader.readline()).decode('utf-8'))
        assert reply.get('op') == 'hello_err'
        writer.close()
        await writer.wait_closed()
    finally:
        proc.kill()
        await proc.wait()


@pytest.mark.asyncio(loop_scope='function')
async def test_broker_accepts_matching_token(tmp_path: Path) -> None:
    token = 'd' * 64
    config = tmp_path / 'cfg.json'
    port_file = tmp_path / 'port.json'
    config.write_text(json.dumps({'token': token, 'python_path': [str(python_package_root())]}), encoding='utf-8')
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        '-m',
        'clara_coder_backend.runtime.admin_broker',
        '--config',
        str(config),
        '--port-file',
        str(port_file),
        cwd=str(python_package_root()),
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        port = await _wait_port_file(port_file)
        reader, writer = await asyncio.open_connection('127.0.0.1', port)
        writer.write((json.dumps({'op': 'hello', 'token': token}) + '\n').encode('utf-8'))
        await writer.drain()
        reply = json.loads((await reader.readline()).decode('utf-8'))
        assert reply.get('op') == 'hello_ok'
        writer.write(b'{"op":"shutdown"}\n')
        await writer.drain()
        writer.close()
        await writer.wait_closed()
    finally:
        proc.kill()
        await proc.wait()


@pytest.mark.asyncio(loop_scope='function')
async def test_broker_exits_after_shutdown_and_removes_token_file(tmp_path: Path) -> None:
    """The sidecar cannot kill an elevated helper, so the helper must exit by itself."""

    token = 'e' * 64
    proc, config, port_file = await _spawn_broker(tmp_path, token)
    try:
        port = await _wait_port_file(port_file)
        # Token config is consumed at startup so it is not left around while the helper lives.
        assert not config.exists()
        reader, writer, reply = await _hello(port, token)
        assert reply.get('op') == 'hello_ok'
        writer.write(b'{"op":"shutdown"}\n')
        await writer.drain()
        bye = json.loads((await asyncio.wait_for(reader.readline(), timeout=10.0)).decode('utf-8'))
        assert bye.get('op') == 'bye'
        writer.close()
        await writer.wait_closed()
        code = await asyncio.wait_for(proc.wait(), timeout=15.0)
        assert code == 0
        assert not port_file.exists()
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()


@pytest.mark.asyncio(loop_scope='function')
async def test_broker_exits_when_authenticated_client_disconnects(tmp_path: Path) -> None:
    token = 'f' * 64
    proc, _config, port_file = await _spawn_broker(tmp_path, token)
    try:
        port = await _wait_port_file(port_file)
        _reader, writer, reply = await _hello(port, token)
        assert reply.get('op') == 'hello_ok'
        # Sidecar crash: connection dropped without a shutdown op.
        writer.close()
        await writer.wait_closed()
        code = await asyncio.wait_for(proc.wait(), timeout=15.0)
        assert code == 0
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()


@pytest.mark.asyncio(loop_scope='function')
async def test_broker_serves_only_one_authenticated_client(tmp_path: Path) -> None:
    token = 'a1' * 32
    proc, _config, port_file = await _spawn_broker(tmp_path, token)
    try:
        port = await _wait_port_file(port_file)
        _r1, w1, first = await _hello(port, token)
        assert first.get('op') == 'hello_ok'
        _r2, w2, second = await _hello(port, token)
        assert second.get('op') == 'hello_err'
        w2.close()
        await w2.wait_closed()
        w1.write(b'{"op":"shutdown"}\n')
        await w1.drain()
        w1.close()
        await w1.wait_closed()
        await asyncio.wait_for(proc.wait(), timeout=15.0)
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()


@pytest.mark.asyncio(loop_scope='function')
async def test_ensure_session_broker_launches_once_for_concurrent_callers(tmp_path: Path) -> None:
    """Two elevated calls racing in one session must not show two UAC / polkit prompts."""

    class _FakeClient:
        def __init__(self) -> None:
            self._alive = True
            self.persist = False

    fake = _FakeClient()
    sid = 'sid-launch-race'
    admin_exec.broker_clients().pop(sid, None)
    with (
        patch.object(admin_exec, '_write_config', return_value=tmp_path / 'cfg.json'),
        patch.object(admin_exec, '_launch_broker_process', new_callable=AsyncMock, return_value=(4242, None)) as launch,
        patch.object(admin_exec, '_wait_port_file', new_callable=AsyncMock, return_value=(5555, 4242, None)),
        patch.object(admin_exec, '_connect_broker', new_callable=AsyncMock, return_value=(fake, None)),
    ):
        results = await asyncio.gather(
            ensure_session_broker(sid, persist=True),
            ensure_session_broker(sid, persist=True),
            ensure_session_broker(sid, persist=False),
        )
    try:
        assert launch.await_count == 1
        assert all(client is fake and err is None for client, err in results)
        assert fake.persist is True
    finally:
        admin_exec.broker_clients().pop(sid, None)


@pytest.mark.asyncio(loop_scope='function')
async def test_warmup_persistent_broker_skips_when_already_privileged() -> None:
    with (
        patch('clara_coder_backend.runtime.admin_exec.is_currently_privileged', return_value=True),
        patch(
            'clara_coder_backend.runtime.admin_exec.ensure_session_broker',
            new_callable=AsyncMock,
        ) as ensure,
    ):
        err = await warmup_persistent_broker('sid-priv')
    assert err is None
    ensure.assert_not_awaited()


@pytest.mark.asyncio(loop_scope='function')
async def test_warmup_persistent_broker_persists_helper() -> None:
    client = object()
    with (
        patch('clara_coder_backend.runtime.admin_exec.is_currently_privileged', return_value=False),
        patch('clara_coder_backend.runtime.admin_exec.admin_elevation_supported', return_value=True),
        patch(
            'clara_coder_backend.runtime.admin_exec.ensure_session_broker',
            new_callable=AsyncMock,
            return_value=(client, None),
        ) as ensure,
    ):
        err = await warmup_persistent_broker('sid-warm')
    assert err is None
    ensure.assert_awaited_once_with('sid-warm', persist=True)


@pytest.mark.asyncio(loop_scope='function')
async def test_warmup_persistent_broker_returns_launch_error() -> None:
    with (
        patch('clara_coder_backend.runtime.admin_exec.is_currently_privileged', return_value=False),
        patch('clara_coder_backend.runtime.admin_exec.admin_elevation_supported', return_value=True),
        patch(
            'clara_coder_backend.runtime.admin_exec.ensure_session_broker',
            new_callable=AsyncMock,
            return_value=(None, 'User cancelled the administrator prompt.'),
        ),
    ):
        err = await warmup_persistent_broker('sid-cancel')
    assert err == 'User cancelled the administrator prompt.'
