import type { OpenRouterCatalogModel } from '@shared/index';

export type OpenRouterModelSort = 'newest' | 'name' | 'context' | 'price';

export const OPENROUTER_MODEL_SORT_OPTIONS: readonly { id: OpenRouterModelSort; label: string }[] = [
  { id: 'newest', label: 'Newest' },
  { id: 'name', label: 'Name' },
  { id: 'context', label: 'Largest context' },
  { id: 'price', label: 'Lowest price' },
];

export interface OpenRouterModelFilter {
  query: string;
  freeOnly: boolean;
  reasoningOnly: boolean;
  sort: OpenRouterModelSort;
}

export function openRouterModelIsFree(model: OpenRouterCatalogModel): boolean {
  return !!model.pricing && model.pricing.prompt === 0 && model.pricing.completion === 0;
}

/** Prompt plus completion price, so unpriced (variable) models sort last. */
function priceKey(model: OpenRouterCatalogModel): number {
  return model.pricing ? model.pricing.prompt + model.pricing.completion : Number.POSITIVE_INFINITY;
}

/**
 * Catalog rows matching every whitespace-separated term of ``query`` (against id and name), in
 * ``sort`` order. Ties keep catalog order, which OpenRouter already returns newest first.
 */
export function filterOpenRouterModels(
  models: readonly OpenRouterCatalogModel[],
  filter: OpenRouterModelFilter,
): OpenRouterCatalogModel[] {
  const terms = filter.query.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = models.filter((model) => {
    if (filter.freeOnly && !openRouterModelIsFree(model)) {
      return false;
    }
    if (filter.reasoningOnly && !model.reasoning) {
      return false;
    }
    const haystack = `${model.id} ${model.name}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  switch (filter.sort) {
    case 'name':
      return rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    case 'context':
      return rows.sort((a, b) => b.contextLength - a.contextLength);
    case 'price':
      return rows.sort((a, b) => priceKey(a) - priceKey(b));
    case 'newest':
      return rows.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  }
}

/** ``200K`` / ``1M`` / ``1.05M``; empty when OpenRouter did not report a context length. */
export function formatOpenRouterContext(tokens: number): string {
  if (tokens <= 0) {
    return '';
  }
  if (tokens >= 1_000_000) {
    return `${Number((tokens / 1_000_000).toFixed(2))}M`;
  }
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}K`;
  }
  return String(tokens);
}

/** USD per million tokens from a per-token price: ``$3``, ``$0.15``, ``$0.075``. */
export function formatOpenRouterPrice(perToken: number): string {
  const perMillion = perToken * 1_000_000;
  if (perMillion >= 100) {
    return `$${Math.round(perMillion)}`;
  }
  if (perMillion >= 0.1) {
    return `$${Number(perMillion.toFixed(2))}`;
  }
  return `$${Number(perMillion.toPrecision(2))}`;
}

/** ``sk-or-…a1b2`` for a stored key, so the card can show which key is saved without revealing it. */
export function maskOpenRouterApiKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) {
    return '';
  }
  if (trimmed.length <= 8) {
    return '•'.repeat(trimmed.length);
  }
  const prefix = trimmed.startsWith('sk-or-') ? 'sk-or-' : '';
  return `${prefix}••••${trimmed.slice(-4)}`;
}
