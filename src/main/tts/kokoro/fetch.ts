import { getPythonSidecarToken } from '../../python/http-client';
import { PYTHON_URL } from '../../python/server';
import type { TtsRequestParams } from '../types';

/**
 * POST to the Python sidecar Kokoro TTS route (`POST /tts`).
 * SSRF / private-host gates are intentionally skipped: ``PYTHON_URL`` is a
 * fixed trusted loopback sidecar address, not a user-controlled base URL.
 */
export async function fetchKokoroTtsResponse(
  params: TtsRequestParams,
  signal: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getPythonSidecarToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return fetch(`${PYTHON_URL}/tts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: params.text, voice: params.voice, speed: params.speed }),
    signal,
  });
}
