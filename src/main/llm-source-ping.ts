/**
 * Ping for the composer's Send gate: can the selected chat source take a request right now?
 *
 * Mirrors how the Python backend resolves each provider's URL and key (``llm/factory.py``) so the
 * ping hits the endpoint a real send would. A managed llama-server is not pinged here: the
 * renderer already tracks it through ``llama-server:status`` and its lifecycle events.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { AppConfig, LlmProviderConfig, LlmSourcePingResult } from '../shared';
import { OPENROUTER_DEFAULT_BASE_URL, findLlmModelLocation } from '../shared';
import { parseAllowedHttpUrl } from '../shared/safe-http-url';
import { unwrapSecret } from '../shared/types/app-config';
import { getAnthropicApiKey } from './anthropic-key-store';
import { pingAnthropicApi } from './anthropic-models';

const PING_TIMEOUT_MS = 4_000;
/** One retry so a dropped packet does not lock the composer until the next poll. */
const RETRY_DELAY_MS = 300;

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_LM_STUDIO_BASE_URL = 'http://127.0.0.1:1234/v1';
const DEFAULT_LLAMACPP_BASE_URL = 'http://127.0.0.1:8080/v1';

/**
 * Only a rejected key and server errors mean a send would fail. Anything else proves the provider
 * answered: restricted keys can chat without listing models (403), some OpenAI-compatible servers
 * have no ``/models`` (404), and a rate limit (429) passes on its own.
 */
function httpStatusFailure(name: string, status: number): string | null {
  if (status === 401) {
    return `${name} rejected the API key (401). Check it in Settings.`;
  }
  return status >= 500 ? `${name} returned HTTP ${status}` : null;
}

/** Same rule as ``normalize_openai_api_base``: trailing slash off, ``/v1`` on. */
function withV1Suffix(raw: string): string {
  const base = raw.trim().replace(/\/+$/, '');
  return base.toLowerCase().endsWith('/v1') ? base : `${base}/v1`;
}

/** ``0.0.0.0`` is a listen address: the backend rewrites it to loopback, and so must a ping. */
function pingUrl(raw: string): URL | null {
  const url = parseAllowedHttpUrl(raw);
  if (url && (url.hostname === '0.0.0.0' || url.hostname === '[::]')) {
    url.hostname = '127.0.0.1';
  }
  return url;
}

async function pingHttp(name: string, target: string, apiKey: string): Promise<LlmSourcePingResult> {
  const url = pingUrl(target);
  if (!url) {
    return { ok: false, error: `${name} has an invalid base URL. Check it in Settings.` };
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const attempt = async (): Promise<number> => {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
    // The status is the answer; a model catalog can be megabytes.
    void res.body?.cancel().catch(() => undefined);
    return res.status;
  };
  try {
    const status = await attempt().catch(async () => {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      return attempt();
    });
    const failure = httpStatusFailure(name, status);
    return failure ? { ok: false, error: failure } : { ok: true };
  } catch {
    return { ok: false, error: `Can't reach ${name} at ${url.origin}` };
  }
}

async function pingAnthropic(name: string): Promise<LlmSourcePingResult> {
  const key = await getAnthropicApiKey();
  if (!key) {
    return { ok: false, error: `Add a ${name} API key in Settings to send` };
  }
  try {
    await pingAnthropicApi(key, PING_TIMEOUT_MS);
    return { ok: true };
  } catch (err) {
    // A connection failure is an APIError with no status.
    const status = err instanceof Anthropic.APIError ? err.status : undefined;
    if (status) {
      const failure = httpStatusFailure(name, status);
      return failure ? { ok: false, error: failure } : { ok: true };
    }
    return { ok: false, error: `Can't reach ${name}. Check your network connection.` };
  }
}

function pingOpenAiCompatible(provider: LlmProviderConfig): Promise<LlmSourcePingResult> {
  const name = provider.name;
  const baseUrl = provider.baseUrl ?? '';
  const key = unwrapSecret(provider.apiKey).trim();
  const missingKey: LlmSourcePingResult = { ok: false, error: `Add a ${name} API key in Settings to send` };
  switch (provider.provider) {
    case 'openai': {
      const apiKey = key || (process.env.OPENAI_API_KEY ?? '').trim();
      const base = baseUrl.trim() || (process.env.OPENAI_BASE_URL ?? '').trim() || DEFAULT_OPENAI_BASE_URL;
      return apiKey ? pingHttp(name, `${base.replace(/\/+$/, '')}/models`, apiKey) : Promise.resolve(missingKey);
    }
    case 'openrouter': {
      // OpenRouter's model list is public, so only ``/key`` proves the key works.
      const apiKey = key || (process.env.OPENROUTER_API_KEY ?? '').trim();
      const base = withV1Suffix(baseUrl.trim() || OPENROUTER_DEFAULT_BASE_URL);
      return apiKey ? pingHttp(name, `${base}/key`, apiKey) : Promise.resolve(missingKey);
    }
    case 'lmstudio': {
      const apiKey = key || (process.env.LM_STUDIO_API_KEY ?? '').trim();
      return pingHttp(name, `${withV1Suffix(baseUrl.trim() || DEFAULT_LM_STUDIO_BASE_URL)}/models`, apiKey);
    }
    case 'llamacpp': {
      const apiKey = key || (process.env.LLAMACPP_API_KEY ?? '').trim();
      return pingHttp(name, `${withV1Suffix(baseUrl.trim() || DEFAULT_LLAMACPP_BASE_URL)}/models`, apiKey);
    }
    default:
      return Promise.resolve({ ok: false, error: `${name} can't be used for chat` });
  }
}

/** Pings the source that owns the model preset ``modelId``. */
export async function pingLlmSource(modelId: string, config: AppConfig): Promise<LlmSourcePingResult> {
  const loc = findLlmModelLocation(config.llmProviders, modelId);
  if (!loc) {
    return { ok: false, error: 'No LLM source selected' };
  }
  const { provider, model } = loc;
  // These two send no default model, so a blank pick fails however healthy the provider is.
  if ((provider.provider === 'anthropic' || provider.provider === 'openrouter') && !(model.model ?? '').trim()) {
    return { ok: false, error: `Choose a ${provider.name} model in Settings to send` };
  }
  return provider.provider === 'anthropic' ? pingAnthropic(provider.name) : pingOpenAiCompatible(provider);
}
