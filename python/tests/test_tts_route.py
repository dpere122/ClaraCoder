"""POST /tts Kokoro integration (mocked synthesis — no torch on CI required)."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

from starlette.testclient import TestClient


def test_tts_returns_wav_stream() -> None:
    from clara_coder_backend.main import app

    fake_wav = b'RIFF\x00\x01fake-wav-bytes'

    with patch('clara_coder_backend.routes_audio.synthesize_wav_bytes', return_value=fake_wav):
        with TestClient(app) as client:
            res = client.post('/tts', json={'text': 'Hello world.', 'voice': 'af_heart', 'speed': 1.0})
    assert res.status_code == 200
    assert res.headers.get('content-type', '').startswith('audio/wav')
    assert res.content == fake_wav


def test_tts_rejects_invalid_voice() -> None:
    from clara_coder_backend.main import app

    with patch('clara_coder_backend.routes_audio.synthesize_wav_bytes', return_value=b'x'):
        with TestClient(app) as client:
            res = client.post('/tts', json={'text': 'Hello', 'voice': 'not-a-voice!!'})
    assert res.status_code == 400


def test_tts_skips_synthesis_when_client_disconnected() -> None:
    from clara_coder_backend.main import app

    with patch('clara_coder_backend.routes_audio.synthesize_wav_bytes', return_value=b'unused') as mock_syn:
        with patch(
            'starlette.requests.Request.is_disconnected',
            new_callable=AsyncMock,
            return_value=True,
        ):
            with TestClient(app) as client:
                res = client.post('/tts', json={'text': 'Hello', 'voice': 'af_heart', 'speed': 1.0})
    assert res.status_code == 200
    assert res.headers.get('content-type', '').startswith('audio/wav')
    assert res.content == b''
    mock_syn.assert_not_called()


def test_tts_accepts_speech_speed_alias() -> None:
    from clara_coder_backend.main import app

    fake_wav = b'RIFF\x02'

    with patch('clara_coder_backend.routes_audio.synthesize_wav_bytes', return_value=fake_wav) as mock_syn:
        with TestClient(app) as client:
            res = client.post('/tts', json={'text': 'Hi', 'speechSpeed': 1.5})
    assert res.status_code == 200
    mock_syn.assert_called_once()
    args = mock_syn.call_args[0]
    assert args[2] == 1.5
