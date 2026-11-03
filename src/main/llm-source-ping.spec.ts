// @vitest-environment node
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, LlmProviderConfig } from '../shared';
import { SecretValue } from '../shared';
import { setAnthropicClientFactoryForTests } from './anthropic-models';
import { getAnthropicApiKey } from './anthropic-key-store';
import { pingLlmSource } from './llm-source-ping';

vi.mock('./anthropic-key-store', () => ({
  anthropicKeyHint: () => '',
  getAnthropicApiKey: vi.fn(async () => ''),
  getAnthropicKeyStorage: vi.fn(async () => 'none'),
}));

function config(provider: LlmProviderConfig['provider'], baseUrl = '', apiKey = '', model = 'm'): AppConfig {
  return {
    llmProviders: [
      {
        id: 'src',
        name: 'Source',
        provider,
        baseUrl,
        apiKey: SecretValue.of(apiKey),
        models: [{ id: 'mid', name: 'M', model }],
      },
    ],
  } as unknown as AppConfig;
}

function answer(status: number): Response {
  return new Response(null, { status });
}

describe('pingLlmSource', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('OPENAI_BASE_URL', '');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.stubEnv('LM_STUDIO_API_KEY', '');
    vi.stubEnv('LLAMACPP_API_KEY', '');
    vi.mocked(getAnthropicApiKey).mockResolvedValue('');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    setAnthropicClientFactoryForTests(null);
  });

  function requested(): { url: string; authorization?: string } {
    const [url, init] = fetchMock.mock.calls[0];
    return { url: String(url), authorization: (init?.headers as Record<string, string>).Authorization };
  }

  it('fails without a request when the model preset is gone', async () => {
    expect(await pingLlmSource('other', config('lmstudio'))).toEqual({ ok: false, error: 'No LLM source selected' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['lmstudio', 'http://127.0.0.1:1234/v1/models'],
    ['llamacpp', 'http://127.0.0.1:8080/v1/models'],
  ] as const)('pings the default %s endpoint without needing a key', async (provider, url) => {
    fetchMock.mockResolvedValue(answer(200));
    expect(await pingLlmSource('mid', config(provider))).toEqual({ ok: true });
    expect(requested()).toEqual({ url, authorization: undefined });
  });

  it('adds /v1 the way the backend does and rewrites a bind-all host', async () => {
    fetchMock.mockResolvedValue(answer(200));
    await pingLlmSource('mid', config('llamacpp', 'http://0.0.0.0:9000/'));
    expect(requested().url).toBe('http://127.0.0.1:9000/v1/models');
  });

  it('sends the saved key to a key-based provider', async () => {
    fetchMock.mockResolvedValue(answer(200));
    await pingLlmSource('mid', config('openai', '', 'sk-test'));
    expect(requested()).toEqual({ url: 'https://api.openai.com/v1/models', authorization: 'Bearer sk-test' });
  });

  it('checks the OpenRouter key rather than its public model list', async () => {
    fetchMock.mockResolvedValue(answer(200));
    await pingLlmSource('mid', config('openrouter', 'https://openrouter.ai/api/v1', 'sk-or'));
    expect(requested().url).toBe('https://openrouter.ai/api/v1/key');
  });

  it.each(['openai', 'openrouter', 'anthropic'] as const)('asks for a key when %s has none', async (provider) => {
    expect(await pingLlmSource('mid', config(provider))).toEqual({
      ok: false,
      error: 'Add a Source API key in Settings to send',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['openrouter', 'anthropic'] as const)('asks for a model when %s has none picked', async (provider) => {
    const result = await pingLlmSource('mid', config(provider, '', 'key', ' '));
    expect(result).toEqual({ ok: false, error: 'Choose a Source model in Settings to send' });
  });

  it.each([200, 403, 404, 429])('treats HTTP %i as connected: the provider answered', async (status) => {
    fetchMock.mockResolvedValue(answer(status));
    expect(await pingLlmSource('mid', config('lmstudio'))).toEqual({ ok: true });
  });

  it.each([
    [401, 'Source rejected the API key (401). Check it in Settings.'],
    [503, 'Source returned HTTP 503'],
  ])('blocks on HTTP %i', async (status, error) => {
    fetchMock.mockResolvedValue(answer(status));
    expect(await pingLlmSource('mid', config('lmstudio'))).toEqual({ ok: false, error });
  });

  it('retries a network failure once, then reports the host', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    expect(await pingLlmSource('mid', config('llamacpp', 'http://10.0.0.5:8080/v1'))).toEqual({
      ok: false,
      error: "Can't reach Source at http://10.0.0.5:8080",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('recovers when the retry gets through', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(answer(200));
    expect(await pingLlmSource('mid', config('lmstudio'))).toEqual({ ok: true });
  });

  it('rejects a URL with embedded credentials before sending anything', async () => {
    expect(await pingLlmSource('mid', config('llamacpp', 'http://user:pw@host/v1'))).toEqual({
      ok: false,
      error: 'Source has an invalid base URL. Check it in Settings.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('Claude', () => {
    function modelsApiAnswers(err: unknown): void {
      vi.mocked(getAnthropicApiKey).mockResolvedValue('sk-ant');
      setAnthropicClientFactoryForTests(
        () => ({ models: { list: () => (err ? Promise.reject(err) : Promise.resolve({})) } }) as never,
      );
    }

    it('is connected when the Models API answers', async () => {
      modelsApiAnswers(null);
      expect(await pingLlmSource('mid', config('anthropic'))).toEqual({ ok: true });
    });

    it('blocks on a rejected key', async () => {
      modelsApiAnswers(new Anthropic.AuthenticationError(401, undefined, 'bad key', new Headers()));
      expect(await pingLlmSource('mid', config('anthropic'))).toEqual({
        ok: false,
        error: 'Source rejected the API key (401). Check it in Settings.',
      });
    });

    it('stays connected for a key that may not list models', async () => {
      modelsApiAnswers(new Anthropic.PermissionDeniedError(403, undefined, 'no', new Headers()));
      expect(await pingLlmSource('mid', config('anthropic'))).toEqual({ ok: true });
    });

    it('blocks when the API cannot be reached', async () => {
      modelsApiAnswers(new Anthropic.APIConnectionError({ message: 'down' }));
      expect(await pingLlmSource('mid', config('anthropic'))).toEqual({
        ok: false,
        error: "Can't reach Source. Check your network connection.",
      });
    });
  });
});
