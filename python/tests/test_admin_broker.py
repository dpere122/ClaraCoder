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

from clara_coder_backend.runtime.admin_exec import python_package_root, warmup_persistent_broker


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
