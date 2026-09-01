"""POST /transcribe provider dispatch (mocked STT backends)."""

from __future__ import annotations

from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from starlette.testclient import TestClient

from clara_coder_backend.session import state

_WAV = b'RIFF\x00\x00fake-wav'


def _restore_audio(orig) -> None:
    state.runtime_config.audio = orig


def test_transcribe_empty_body_returns_empty_text() -> None:
    from clara_coder_backend.main import app

    with TestClient(app) as client:
        res = client.post('/transcribe', content=b'')
    assert res.status_code == 200
    assert res.json() == {'text': ''}


def test_transcribe_disabled_returns_400() -> None:
    from clara_coder_backend.main import app

    orig = deepcopy(state.runtime_config.audio)
    state.runtime_config.audio.provider = 'disabled'
    try:
        with TestClient(app) as client:
            res = client.post('/transcribe', content=_WAV)
        assert res.status_code == 400
    finally:
        _restore_audio(orig)


def test_transcribe_whisper_returns_text() -> None:
    from clara_coder_backend.main import app

    orig = deepcopy(state.runtime_config.audio)
    state.runtime_config.audio.provider = 'whisper'
    try:
        with patch('clara_coder_backend.routes.audio.transcribe_whisper', return_value='hello'):
            with TestClient(app) as client:
                res = client.post('/transcribe', content=_WAV)
        assert res.status_code == 200
        assert res.json() == {'text': 'hello'}
    finally:
        _restore_audio(orig)


def test_transcribe_whisper_missing_dep_returns_503() -> None:
    from clara_coder_backend.main import app

    orig = deepcopy(state.runtime_config.audio)
    state.runtime_config.audio.provider = 'whisper'
    try:
        with patch(
            'clara_coder_backend.routes.audio.transcribe_whisper',
            side_effect=RuntimeError('Whisper STT is not installed. Open Dependencies'),
        ):
            with TestClient(app) as client:
                res = client.post('/transcribe', content=_WAV)
        assert res.status_code == 503
        assert 'Dependencies' in res.json()['detail']
    finally:
        _restore_audio(orig)


def test_transcribe_whisper_missing_size_returns_503() -> None:
    from clara_coder_backend.main import app

    orig = deepcopy(state.runtime_config.audio)
    state.runtime_config.audio.provider = 'whisper'
    try:
        with patch(
            'clara_coder_backend.routes.audio.transcribe_whisper',
            side_effect=RuntimeError(
                "Whisper model 'medium' is not downloaded. Open Dependencies and download that size."
            ),
        ):
            with TestClient(app) as client:
                res = client.post('/transcribe', content=_WAV)
        assert res.status_code == 503
        assert 'Dependencies' in res.json()['detail']
    finally:
        _restore_audio(orig)


def test_transcribe_openai_returns_text() -> None:
    from clara_coder_backend.main import app

    orig = deepcopy(state.runtime_config.audio)
    state.runtime_config.audio.provider = 'openai'
    state.runtime_config.audio.api_key = 'sk-test'
    fake = MagicMock()
    fake.audio.transcriptions.create.return_value = SimpleNamespace(text='from-openai')
    try:
        with patch('clara_coder_backend.routes.audio.get_openai_client', return_value=fake):
            with TestClient(app) as client:
                res = client.post('/transcribe', content=_WAV)
        assert res.status_code == 200
        assert res.json() == {'text': 'from-openai'}
        fake.audio.transcriptions.create.assert_called_once()
    finally:
        _restore_audio(orig)
