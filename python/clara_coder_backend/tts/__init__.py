"""Text-to-speech providers for the Clara Coder sidecar.

Modules
-------
``kokoro`` — local Kokoro-82M synthesis (served by ``POST /tts``)
``openai_compatible`` — OpenAI-compatible ``/v1/audio/speech`` client helpers

Electron main chooses the provider (``ttsProvider``) and either calls Python
Kokoro via ``/tts`` or hits an OpenAI-compatible endpoint directly.
"""
