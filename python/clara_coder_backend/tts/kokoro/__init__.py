"""Local Kokoro-82M text-to-speech."""

from clara_coder_backend.tts.kokoro.synthesize import (
    lang_code_for_voice,
    synthesize_wav_bytes,
    validate_voice_name,
)

__all__ = [
    'lang_code_for_voice',
    'synthesize_wav_bytes',
    'validate_voice_name',
]
