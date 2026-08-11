"""Tests for security/python-sidecar-auth — subtask 6 (secrets-in-memory-redaction).

Verifies ``RuntimeConnection`` / ``RuntimeAudioConfig`` ``__repr__``/``__str__``
mask ``api_key`` as ``***`` (or ``''`` when empty), so secrets never appear
in repr/logs.
"""
from __future__ import annotations

from clara_coder_backend.domain import RuntimeAudioConfig, RuntimeConnection


def test_runtime_connection_api_key_masked() -> None:
    conn = RuntimeConnection(
        id='1', name='openai', provider='openai',
        base_url='https://api.openai.com', model='gpt-4',
        api_key='sk-SECRET-123456789',
    )
    r = repr(conn)
    assert 'sk-SECRET-123456789' not in r
    assert '***' in r
    assert 'sk-SECRET-123456789' not in str(conn)


def test_runtime_connection_empty_key_shows_empty_not_mask() -> None:
    conn = RuntimeConnection(
        id='2', name='lm-studio', provider='lm-studio',
        base_url='http://127.0.0.1:1234', model='local', api_key='',
    )
    r = repr(conn)
    assert "api_key=''" in r
    assert '***' not in r


def test_runtime_audio_config_api_key_masked() -> None:
    audio = RuntimeAudioConfig(
        provider='openai', base_url='https://api.openai.com',
        model='whisper-1', api_key='sk-AUDIO-SECRET',
    )
    r = repr(audio)
    assert 'sk-AUDIO-SECRET' not in r
    assert '***' in r
    assert 'sk-AUDIO-SECRET' not in str(audio)
