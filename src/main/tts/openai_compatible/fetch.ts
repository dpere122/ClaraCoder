import type { AudioTranscriptionConfig } from '../../../shared';
import { DEFAULT_OPENAI_TTS_BASE_URL } from '../../../shared';
import { parseAllowedHttpUrl } from '../../../shared/safe-http-url';
import { isPrivateHost, type TtsRequestParams } from '../types';
import { normalizeOpenAiBaseUrl } from './normalize-base-url';

const MAX_REDIRECTS = 5;

function assertAllowedTtsTarget(url: URL): void {
  if (isPrivateHost(url) && process.env.TTS_ALLOW_PRIVATE_TARGETS !== '1') {
    console.warn(
      '[TTS] Rejected private/loopback/link-local TTS target; set TTS_ALLOW_PRIVATE_TARGETS=1 to allow:',
      url.hostname,
    );
    throw new Error('TTS target not allowed');
  }
}

/** Resolve Location, re-run parseAllowedHttpUrl + isPrivateHost before following. */
function resolveAllowedRedirect(currentUrl: string, location: string): URL {
  let absolute: URL;
  try {
    absolute = new URL(location, currentUrl);
  } catch {
    throw new Error('Invalid TTS redirect URL');
  }
  const parsed = parseAllowedHttpUrl(absolute.toString());
  if (!parsed) {
    throw new Error('Invalid TTS redirect URL');
  }
  assertAllowedTtsTarget(parsed);
  return parsed;
}

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
  assertAllowedTtsTarget(baseUrl);

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

  const bodyJson = JSON.stringify(body);
  let currentUrl = speechUrl.toString();
  // redirect:'manual' — undici follows by default; public base can 302 to 169.254.169.254
  // and bypass isPrivateHost. Re-validate every Location before following.
  let response = await fetch(currentUrl, {
    method: 'POST',
    headers,
    body: bodyJson,
    signal,
    redirect: 'manual',
  });

  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    if (response.status < 300 || response.status >= 400) {
      return response;
    }
    const location = response.headers.get('location');
    if (!location) {
      throw new Error('TTS redirect missing Location');
    }
    const next = resolveAllowedRedirect(currentUrl, location);
    currentUrl = next.toString();
    // Fetch redirect semantics: 303 → GET; 307/308 keep method; 301/302 typically GET for POST.
    const preserveMethod = response.status === 307 || response.status === 308;
    response = await fetch(currentUrl, {
      method: preserveMethod ? 'POST' : 'GET',
      headers: preserveMethod ? headers : {},
      body: preserveMethod ? bodyJson : undefined,
      signal,
      redirect: 'manual',
    });
  }

  throw new Error('Too many TTS redirects');
}
