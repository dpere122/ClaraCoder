import type { AudioTranscriptionConfig } from '../../../shared';
import { DEFAULT_OPENAI_TTS_BASE_URL } from '../../../shared';
import { parseAllowedHttpUrl } from '../../../shared/safe-http-url';
import { isPrivateHost, type TtsRequestParams } from '../types';
import { normalizeOpenAiBaseUrl } from './normalize-base-url';

/** POST to an OpenAI-compatible ``/v1/audio/speech`` endpoint (WAV). */
export async function fetchOpenAiCompatibleTtsResponse(
  audioConfig: AudioTranscriptionConfig,
  params: TtsRequestParams,
  signal: AbortSignal,
): Promise<Response> {
  const normalized = normalizeOpenAiBaseUrl(audioConfig.ttsBaseUrl?.trim() || DEFAULT_OPENAI_TTS_BASE_URL);
  const baseUrl = normalized ? parseAllowedHttpUrl(normalized) : null;
  if (!baseUrl) {
    throw new Error('Invalid TTS base URL');
  }
  if (isPrivateHost(baseUrl) && process.env.TTS_ALLOW_PRIVATE_TARGETS !== '1') {
    console.warn(
      '[TTS] Rejected private/loopback/link-local TTS target; set TTS_ALLOW_PRIVATE_TARGETS=1 to allow:',
      baseUrl.hostname,
    );
    throw new Error('TTS target not allowed');
  }

  const speechUrl = new URL(baseUrl.toString());
  const basePath = speechUrl.pathname.replace(/\/+$/, '');
  speechUrl.pathname = `${basePath}/v1/audio/speech`;

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
  return fetch(speechUrl.toString(), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
}
