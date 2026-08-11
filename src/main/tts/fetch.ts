import type { AudioTranscriptionConfig } from '../../shared';
import { DEFAULT_TTS_PROVIDER } from '../../shared';
import { fetchKokoroTtsResponse } from './kokoro/fetch';
import { fetchOpenAiCompatibleTtsResponse } from './openai_compatible/fetch';
import type { TtsRequestParams } from './types';

export type { TtsRequestParams } from './types';
export { normalizeOpenAiBaseUrl } from './openai_compatible/normalize-base-url';

/** POST to Kokoro (local Python) or OpenAI-compatible ``/v1/audio/speech``. */
export async function fetchTtsResponse(
  audioConfig: AudioTranscriptionConfig,
  params: TtsRequestParams,
  signal: AbortSignal,
): Promise<Response> {
  const provider = audioConfig.ttsProvider ?? DEFAULT_TTS_PROVIDER;
  if (provider === 'openai-compatible') {
    return fetchOpenAiCompatibleTtsResponse(audioConfig, params, signal);
  }
  // Kokoro targets the trusted local PYTHON_URL sidecar; SSRF validation applies
  // only to user-configured OpenAI-compatible bases (see openai_compatible/fetch.ts).
  return fetchKokoroTtsResponse(params, signal);
}
