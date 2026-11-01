/**
 * Built-in metasearch engines offered by the backend's `web_search` tool.
 *
 * Mirrors `ENGINE_NAMES` in `python/clara_coder_backend/tools/metasearch/engines.py`;
 * `python/tests/test_metasearch.py` asserts the two lists stay in sync.
 */

export interface WebSearchEngineOption {
  /** Engine id sent to the backend. */
  id: string;
  /** Label shown in Settings → Tools. */
  label: string;
}

/** Display order is also the canonical order used when persisting the selection. */
export const WEB_SEARCH_ENGINES: readonly WebSearchEngineOption[] = [
  { id: 'duckduckgo', label: 'DuckDuckGo' },
  { id: 'bing', label: 'Bing' },
  { id: 'mojeek', label: 'Mojeek' },
  { id: 'wikipedia', label: 'Wikipedia' },
];

export const WEB_SEARCH_ENGINE_IDS: readonly string[] = WEB_SEARCH_ENGINES.map((engine) => engine.id);

/**
 * Keep only known engine ids, lowercased, de-duplicated, in canonical order.
 * An empty result means "every engine" to the backend.
 */
export function normalizeWebSearchEngines(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const wanted = new Set(
    raw.filter((value): value is string => typeof value === 'string').map((value) => value.trim().toLowerCase()),
  );
  return WEB_SEARCH_ENGINE_IDS.filter((id) => wanted.has(id));
}
