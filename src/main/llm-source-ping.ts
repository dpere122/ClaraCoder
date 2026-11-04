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
import { openAiCompatBaseUrl } from '../shared/openai-compat';
import { parseAllowedHttpUrl } from '../shared/safe-http-url';
import { unwrapSecret } from '../shared/types/app-config';
import { getAnthropicApiKey } from './anthropic-key-store';
import { pingAnthropicApi } from './anthropic-models';
import { envProxyFetch } from './env-proxy-fetch';
import { ensureOpenAiV1Base, normalizeBindAllHostToLocalhost } from './python/workspace-sync';

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

/** The backend's blank-URL default for a provider: its environment variable, then the built-in one. */
function envOr(name: string, fallback: string): string {
  return (process.env[name] ?? '').trim() || fallback;
}

/** ``fetch`` refuses a URL with ``user:pw@``; httpx sends those as Basic auth, so the ping does too. */
function withoutCredentials(raw: string): { target: string; basicAuth: string } {
  const target = raw.includes('://') ? raw : `http://${raw}`;
  try {
    const url = new URL(target);
    if (!url.username && !url.password) {
      return { target, basicAuth: '' };
    }
    const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    url.username = '';
    url.password = '';
    return { target: url.href, basicAuth: Buffer.from(credentials).toString('base64') };
  } catch {
    return { target, basicAuth: '' };
  }
}

async function pingHttp(name: string, rawTarget: string, apiKey: string, extraHeaders: Record<string, string> = {}): Promise<LlmSourcePingResult> {
  const { target, basicAuth } = withoutCredentials(normalizeBindAllHostToLocalhost(rawTarget));
  const url = parseAllowedHttpUrl(target);
  if (!url) {
    return { ok: false, error: `${name} has an invalid base URL. Check it in Settings.` };
  }
  const headers: Record<string, string> = { Accept: 'application/json', ...extraHeaders };
  if (basicAuth) {
    headers.Authorization = `Basic ${basicAuth}`;
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const attempt = async (): Promise<number> => {
    const res = await envProxyFetch(url, { headers, signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
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
  const key = (await getAnthropicApiKey()) || (process.env.ANTHROPIC_API_KEY ?? '').trim();
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
      const base = baseUrl.trim() || envOr('OPENAI_BASE_URL', DEFAULT_OPENAI_BASE_URL);
      return apiKey ? pingHttp(name, `${base.replace(/\/+$/, '')}/models`, apiKey) : Promise.resolve(missingKey);
    }
    case 'openrouter': {
      // OpenRouter's model list is public, so only ``/key`` proves the key works.
      const apiKey = key || (process.env.OPENROUTER_API_KEY ?? '').trim();
      const base = ensureOpenAiV1Base(baseUrl.trim() || envOr('OPENROUTER_BASE_URL', OPENROUTER_DEFAULT_BASE_URL));
      return apiKey ? pingHttp(name, `${base}/key`, apiKey) : Promise.resolve(missingKey);
    }
    case 'lmstudio': {
      const apiKey = key || (process.env.LM_STUDIO_API_KEY ?? '').trim();
      const base = ensureOpenAiV1Base(baseUrl.trim() || envOr('LM_STUDIO_BASE_URL', DEFAULT_LM_STUDIO_BASE_URL));
      return pingHttp(name, `${base}/models`, apiKey);
    }
    case 'openai-compatible': {
      const base = openAiCompatBaseUrl(baseUrl);
      if (!base) {
        return Promise.resolve({ ok: false, error: `Add a base URL for ${name} in Settings to send` });
      }
      const extra = Object.fromEntries((provider.customHeaders ?? []).map((h) => [h.key, unwrapSecret(h.value)]));
      return pingHttp(name, `${base}/models`, key, extra);
    }
    case 'llamacpp': {
      const apiKey = key || (process.env.LLAMACPP_API_KEY ?? '').trim();
      const base = ensureOpenAiV1Base(baseUrl.trim() || envOr('LLAMACPP_BASE_URL', DEFAULT_LLAMACPP_BASE_URL));
      return pingHttp(name, `${base}/models`, apiKey);
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
  if ((provider.provider === 'anthropic' || provider.provider === 'openrouter' || provider.provider === 'openai-compatible') && !(model.model ?? '').trim()) {
    return { ok: false, error: `Choose a ${provider.name} model in Settings to send` };
  }
  return provider.provider === 'anthropic' ? pingAnthropic(provider.name) : pingOpenAiCompatible(provider);
}
