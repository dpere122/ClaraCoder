"""Local faster-whisper transcription (mocked model — no CTranslate2 on CI)."""

from __future__ import annotations

from pathlib import Path

from clara_coder_backend.audio import transcribe as t
from clara_coder_backend.domain import RuntimeAudioConfig
from clara_coder_backend.session import state


class _Seg:
    def __init__(self, text: str) -> None:
        self.text = text


class _FakeModel:
    def transcribe(self, path: str, **kwargs):
        assert path.endswith('.wav')
        assert kwargs.get('beam_size') == 1
        assert kwargs.get('vad_filter') is True
        assert kwargs.get('condition_on_previous_text') is False
        return [_Seg(' hello'), _Seg(' world')], None


class _EmptyVadModel:
    def transcribe(self, path: str, **kwargs):
        return [], None


def test_transcribe_whisper_joins_segments(monkeypatch, tmp_path: Path) -> None:
    wav = tmp_path / 'utt.wav'
    wav.write_bytes(b'RIFF')
    monkeypatch.setattr(t, '_get_whisper_model', lambda name, root: _FakeModel())
    orig = state.runtime_config.audio
    state.runtime_config.audio = RuntimeAudioConfig(
        provider='whisper',
        base_url='',
        model='tiny',
        api_key='',
        custom_models_dir=str(tmp_path),
    )
    try:
        assert t.transcribe_whisper(str(wav)) == 'hello world'
    finally:
        state.runtime_config.audio = orig
        t.reset_whisper_model_cache()


def test_transcribe_whisper_empty_vad_returns_empty(monkeypatch, tmp_path: Path) -> None:
    wav = tmp_path / 'utt.wav'
    wav.write_bytes(b'RIFF')
    monkeypatch.setattr(t, '_get_whisper_model', lambda name, root: _EmptyVadModel())
    orig = state.runtime_config.audio
    state.runtime_config.audio = RuntimeAudioConfig(
        provider='whisper',
        base_url='',
        model='tiny',
        api_key='',
        custom_models_dir=str(tmp_path),
    )
    try:
        assert t.transcribe_whisper(str(wav)) == ''
    finally:
        state.runtime_config.audio = orig
        t.reset_whisper_model_cache()


def test_transcribe_whisper_missing_package(monkeypatch, tmp_path: Path) -> None:
    wav = tmp_path / 'utt.wav'
    wav.write_bytes(b'RIFF')

    def _boom(_name: str, _root: str):
        raise RuntimeError(t._WHISPER_MISSING)

    monkeypatch.setattr(t, '_get_whisper_model', _boom)
    orig = state.runtime_config.audio
    state.runtime_config.audio = RuntimeAudioConfig(
        provider='whisper',
        base_url='',
        model='small',
        api_key='',
        custom_models_dir=str(tmp_path),
    )
    try:
        try:
            t.transcribe_whisper(str(wav))
            raise AssertionError('expected RuntimeError')
        except RuntimeError as exc:
            assert 'Dependencies' in str(exc)
    finally:
        state.runtime_config.audio = orig


def test_looks_like_missing_weights() -> None:
    assert t._looks_like_missing_weights(FileNotFoundError('cannot find an offline file'))
    assert not t._looks_like_missing_weights(RuntimeError('CUDA OOM'))
