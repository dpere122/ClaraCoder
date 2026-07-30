import type { AudioTranscriptionConfig } from '../../shared';
import { DEFAULT_OPENAI_TTS_BASE_URL, DEFAULT_TTS_PROVIDER } from '../../shared';
import { PYTHON_URL } from '../python/server';

/** Strip trailing slashes; remove common OpenAI path suffixes if pasted by mistake. */
export function normalizeOpenAiBaseUrl(baseUrl: string): string {
  let url = baseUrl.trim();
  while (url.endsWith('/')) {
    url = url.slice(0, -1);
  }
  url = url.replace(/\/v1\/audio\/speech\/?$/i, '');
  url = url.replace(/\/v1\/audio\/?$/i, '');
  if (url.toLowerCase().endsWith('/v1')) {
    url = url.slice(0, -3);
    while (url.endsWith('/')) {
      url = url.slice(0, -1);
    }
  }
  return url;
}

export interface TtsRequestParams {
  text: string;
  voice: string;
  speed: number;
  /** OpenAI-compatible style / mood instructions (Qwen ``instruct``); ignored by Kokoro. */
  instructions?: string;
}

/** POST to Kokoro (local Python) or OpenAI-compatible ``/v1/audio/speech``. */
export async function fetchTtsResponse(
  audioConfig: AudioTranscriptionConfig,
  params: TtsRequestParams,
  signal: AbortSignal,
): Promise<Response> {
  const provider = audioConfig.ttsProvider ?? DEFAULT_TTS_PROVIDER;
  if (provider === 'openai-compatible') {
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

  return fetch(`${PYTHON_URL}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: params.text, voice: params.voice, speed: params.speed }),
    signal,
  });
}
