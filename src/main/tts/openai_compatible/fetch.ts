import type { AudioTranscriptionConfig } from '../../../shared';
import { DEFAULT_OPENAI_TTS_BASE_URL } from '../../../shared';
import type { TtsRequestParams } from '../types';
import { normalizeOpenAiBaseUrl } from './normalize-base-url';

/** POST to an OpenAI-compatible ``/v1/audio/speech`` endpoint (WAV). */
export async function fetchOpenAiCompatibleTtsResponse(
  audioConfig: AudioTranscriptionConfig,
  params: TtsRequestParams,
  signal: AbortSignal,
): Promise<Response> {
  const base = normalizeOpenAiBaseUrl(audioConfig.ttsBaseUrl?.trim() || DEFAULT_OPENAI_TTS_BASE_URL);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const apiKey = audioConfig.ttsApiKey?.trim();
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const body: Record<string, unknown> = {
    input: params.text,
    voice: params.voice,
    model: 'qwen3-tts-custom-voice',
    response_format: 'wav',
    speed: params.speed,
  };
  const instructions = params.instructions?.trim();
  if (instructions) {
    body.instructions = instructions;
  }
  return fetch(`${base}/v1/audio/speech`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
}
