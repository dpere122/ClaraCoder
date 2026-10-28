import { describe, expect, it, vi } from 'vitest';
import { openRouterReasoningCaps, openRouterSourceLabel, type LlmProviderConfig } from '../shared';
import { fetchOpenRouterCatalog, parseOpenRouterModelsPage } from './openrouter-models';

describe('parseOpenRouterModelsPage', () => {
  it('reads id, name, and context_length', () => {
    const page = parseOpenRouterModelsPage({
      data: [
        { id: 'openai/gpt-4.1', name: 'GPT-4.1', context_length: 1047576 },
        { id: '  anthropic/claude-sonnet-4.5  ', context_length: 200000 },
        { id: '', name: 'skip' },
        { name: 'no id' },
      ],
      links: { next: '/api/v1/models?offset=2' },
    });
    expect(page.models).toEqual([
      { id: 'openai/gpt-4.1', name: 'GPT-4.1', contextLength: 1047576 },
      { id: 'anthropic/claude-sonnet-4.5', name: 'anthropic/claude-sonnet-4.5', contextLength: 200000 },
    ]);
    expect(page.next).toBe('/api/v1/models?offset=2');
  });

  it('reads the reasoning block and omits it for models that do not reason', () => {
    const page = parseOpenRouterModelsPage({
      data: [
        {
          id: 'anthropic/claude-sonnet-5.5',
          context_length: 1000000,
          reasoning: { mandatory: true, supported_efforts: ['max', 'High', ''], default_effort: 'high' },
        },
        { id: 'qwen/qwen3', context_length: 1000, reasoning: { mandatory: false, default_enabled: false } },
        { id: 'openai/gpt-4.1', context_length: 1000 },
      ],
    });
    expect(page.models.map((m) => m.reasoning)).toEqual([
      { mandatory: true, supportedEfforts: ['max', 'high'], defaultEffort: 'high' },
      { mandatory: false, supportedEfforts: [], defaultEnabled: false },
      undefined,
    ]);
    expect('reasoning' in page.models[2]).toBe(false);
  });

  it('reads per-token pricing and created, dropping variable or missing prices', () => {
    const page = parseOpenRouterModelsPage({
      data: [
        { id: 'a/paid', created: 1750000000, pricing: { prompt: '0.000003', completion: '0.000015' } },
        { id: 'a/free', pricing: { prompt: '0', completion: '0' } },
        { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } },
        { id: 'a/half', pricing: { prompt: '0.000001' } },
      ],
    });
    expect(page.models.map((m) => [m.pricing, m.created])).toEqual([
      [{ prompt: 0.000003, completion: 0.000015 }, 1750000000],
      [{ prompt: 0, completion: 0 }, undefined],
      [undefined, undefined],
      [undefined, undefined],
    ]);
  });
});

describe('openRouterReasoningCaps', () => {
  it('hides every control for models without reasoning', () => {
    expect(openRouterReasoningCaps(undefined)).toEqual({ enableThinking: false, reasoningEffortValues: null });
  });

  it('shows no off switch for mandatory reasoning and lists efforts lowest first', () => {
    expect(
      openRouterReasoningCaps({ mandatory: true, supportedEfforts: ['max', 'xhigh', 'high', 'medium', 'low'] }),
    ).toEqual({ enableThinking: false, reasoningEffortValues: ['low', 'medium', 'high', 'xhigh', 'max'] });
  });

  it('leaves none to the toggle and drops unknown tokens', () => {
    expect(
      openRouterReasoningCaps({ mandatory: false, supportedEfforts: ['high', 'none', 'minimal', 'turbo'] }),
    ).toEqual({ enableThinking: true, reasoningEffortValues: ['minimal', 'high'] });
  });

  it('offers only the toggle when the model lists no effort levels', () => {
    expect(openRouterReasoningCaps({ mandatory: false, supportedEfforts: [] })).toEqual({
      enableThinking: true,
      reasoningEffortValues: null,
    });
  });
});

describe('openRouterSourceLabel', () => {
  const source = (model: string, name: string) =>
    ({ id: 'openrouter-default', name: 'OpenRouter', provider: 'openrouter', models: [{ model, name }] }) as unknown as LlmProviderConfig;

  it('appends the catalog name of the chosen model without its vendor prefix', () => {
    expect(openRouterSourceLabel(source('anthropic/claude-sonnet-4.5', 'Anthropic: Claude Sonnet 4.5'))).toBe(
      'OpenRouter · Claude Sonnet 4.5',
    );
    expect(openRouterSourceLabel(source('openrouter/auto', 'Auto Router'))).toBe('OpenRouter · Auto Router');
  });

  it('falls back to the model id, and to the source name with no model', () => {
    expect(openRouterSourceLabel(source('acme/new-model', 'OpenRouter'))).toBe('OpenRouter · acme/new-model');
    expect(openRouterSourceLabel(source('acme/new-model', ''))).toBe('OpenRouter · acme/new-model');
    expect(openRouterSourceLabel(source('', 'OpenRouter'))).toBe('OpenRouter');
  });
});

describe('fetchOpenRouterCatalog', () => {
  it('follows one links.next page and keeps the tool filter', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith('https://openrouter.ai/api/v1/models?supported_parameters=tools') && !url.includes('offset=')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ id: 'openai/gpt-4.1', name: 'GPT-4.1', context_length: 1000 }],
            links: { next: 'https://openrouter.ai/api/v1/models?offset=1' },
          }),
        };
      }
      expect(url).toContain('supported_parameters=tools');
      expect(url).toContain('offset=1');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: 'anthropic/claude-sonnet-4.5', name: 'Claude', context_length: 200000 }],
        }),
      };
    });
    const res = await fetchOpenRouterCatalog(
      'https://openrouter.ai/api/v1',
      'sk-or-test',
      fetchImpl as unknown as typeof fetch,
    );
    expect(res).toEqual({
      ok: true,
      models: [
        { id: 'openai/gpt-4.1', name: 'GPT-4.1', contextLength: 1000 },
        { id: 'anthropic/claude-sonnet-4.5', name: 'Claude', contextLength: 200000 },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstInit = fetchImpl.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
    expect(firstInit?.headers?.Authorization).toBe('Bearer sk-or-test');
  });
});
