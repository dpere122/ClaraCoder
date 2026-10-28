import type { OpenRouterCatalogModel } from '@shared/index';
import {
  filterOpenRouterModels,
  formatOpenRouterContext,
  formatOpenRouterPrice,
  maskOpenRouterApiKey,
  type OpenRouterModelFilter,
} from './openrouter-model-search';

const catalog: OpenRouterCatalogModel[] = [
  {
    id: 'anthropic/claude-sonnet-4.5',
    name: 'Anthropic: Claude Sonnet 4.5',
    contextLength: 1_000_000,
    created: 300,
    pricing: { prompt: 0.000003, completion: 0.000015 },
    reasoning: { mandatory: false, supportedEfforts: [] },
  },
  {
    id: 'qwen/qwen3-coder:free',
    name: 'Qwen: Qwen3 Coder (free)',
    contextLength: 262_144,
    created: 200,
    pricing: { prompt: 0, completion: 0 },
  },
  { id: 'openrouter/auto', name: 'Auto Router', contextLength: 2_000_000, created: 100 },
];

const all: OpenRouterModelFilter = { query: '', freeOnly: false, reasoningOnly: false, sort: 'newest' };
const ids = (rows: OpenRouterCatalogModel[]) => rows.map((m) => m.id);

describe('filterOpenRouterModels', () => {
  it('matches every term against id or name, in any order', () => {
    expect(ids(filterOpenRouterModels(catalog, { ...all, query: 'coder QWEN' }))).toEqual(['qwen/qwen3-coder:free']);
    expect(ids(filterOpenRouterModels(catalog, { ...all, query: 'anthropic/' }))).toEqual([
      'anthropic/claude-sonnet-4.5',
    ]);
    expect(filterOpenRouterModels(catalog, { ...all, query: 'gemini' })).toEqual([]);
  });

  it('filters to free or reasoning models', () => {
    expect(ids(filterOpenRouterModels(catalog, { ...all, freeOnly: true }))).toEqual(['qwen/qwen3-coder:free']);
    expect(ids(filterOpenRouterModels(catalog, { ...all, reasoningOnly: true }))).toEqual([
      'anthropic/claude-sonnet-4.5',
    ]);
  });

  it('sorts by context and by price with unpriced models last', () => {
    expect(ids(filterOpenRouterModels(catalog, { ...all, sort: 'context' }))).toEqual([
      'openrouter/auto',
      'anthropic/claude-sonnet-4.5',
      'qwen/qwen3-coder:free',
    ]);
    expect(ids(filterOpenRouterModels(catalog, { ...all, sort: 'price' }))).toEqual([
      'qwen/qwen3-coder:free',
      'anthropic/claude-sonnet-4.5',
      'openrouter/auto',
    ]);
  });

  it('does not reorder the input array', () => {
    filterOpenRouterModels(catalog, { ...all, sort: 'name' });
    expect(ids(catalog)).toEqual(['anthropic/claude-sonnet-4.5', 'qwen/qwen3-coder:free', 'openrouter/auto']);
  });
});

describe('OpenRouter formatting', () => {
  it('formats context lengths', () => {
    expect(formatOpenRouterContext(0)).toBe('');
    expect(formatOpenRouterContext(262_144)).toBe('262K');
    expect(formatOpenRouterContext(1_048_576)).toBe('1.05M');
  });

  it('formats per-token prices per million tokens', () => {
    expect(formatOpenRouterPrice(0.000003)).toBe('$3');
    expect(formatOpenRouterPrice(0.00000015)).toBe('$0.15');
    expect(formatOpenRouterPrice(0.000000075)).toBe('$0.075');
    expect(formatOpenRouterPrice(0.00015)).toBe('$150');
  });

  it('masks a stored key down to its last four characters', () => {
    expect(maskOpenRouterApiKey('  ')).toBe('');
    expect(maskOpenRouterApiKey('sk-or-v1-abcdef1234')).toBe('sk-or-••••1234');
    expect(maskOpenRouterApiKey('short')).toBe('•••••');
  });
});
