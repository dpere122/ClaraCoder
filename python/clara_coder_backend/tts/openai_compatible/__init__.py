"""OpenAI-compatible TTS (``POST {base}/v1/audio/speech``).

Electron main usually calls this endpoint directly. These helpers exist for
sidecar use (tests, future route dispatch) and mirror the Electron client.
"""

from clara_coder_backend.tts.openai_compatible.base_url import normalize_openai_tts_base_url
from clara_coder_backend.tts.openai_compatible.client import synthesize_wav_bytes

__all__ = [
    'normalize_openai_tts_base_url',
    'synthesize_wav_bytes',
]
