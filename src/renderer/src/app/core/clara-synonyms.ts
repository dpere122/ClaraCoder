import type { ClaraAgentMode } from '@shared/index';

const DATAMUSE_URL = 'https://api.datamuse.com/words';

const MANAGER_SEEDS = ['planning', 'wondering', 'pondering', 'solving', 'innovating'] as const;
const WORKER_SEEDS = ['coding', 'programming', 'implementing'] as const;

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

function titleCaseWord(word: string): string {
  const w = word.trim();
  if (!w) return w;
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

/** One random synonym for a random seed from `seeds` via Datamuse; falls back to the seed on failure. */
export async function fetchRandomSynonymForSeeds(seeds: readonly string[]): Promise<string> {
  const seed = pick(seeds);
  try {
    const url = `${DATAMUSE_URL}?${new URLSearchParams({ rel_syn: seed, max: '32' })}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Datamuse ${res.status}`);
    const data = (await res.json()) as { word?: string }[];
    if (Array.isArray(data) && data.length > 0) {
      const row = pick(data);
      if (row.word?.trim()) return titleCaseWord(row.word);
    }
  } catch {
    // offline, CORS, or empty — use seed
  }
  return titleCaseWord(seed);
}

export async function claraProcessingPhraseForMode(mode: ClaraAgentMode): Promise<string> {
  if (mode === 'CLARA_AGENT') return 'Clara';
  if (mode === 'CLARA_MANAGER') {
    const word = await fetchRandomSynonymForSeeds(MANAGER_SEEDS);
    return `Clara ${word}`;
  }
  const word = await fetchRandomSynonymForSeeds(WORKER_SEEDS);
  return `Clara ${word}`;
}
