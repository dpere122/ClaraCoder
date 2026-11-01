import type { AnthropicCatalogModel } from '@shared/index';

/** Dropdown order for model lines; unknown lines sort after these. */
const LINE_ORDER = ['fable', 'mythos', 'opus', 'sonnet', 'haiku'];

/** ``opus`` → ``Opus``; models with no line go under ``Other``. */
export function claudeLineLabel(line: string | undefined): string {
  const l = (line ?? '').trim();
  return l ? l.charAt(0).toUpperCase() + l.slice(1) : 'Other';
}

function lineRank(line: string | undefined): number {
  const i = LINE_ORDER.indexOf((line ?? '').toLowerCase());
  return i >= 0 ? i : LINE_ORDER.length;
}

/**
 * Pill-select rows grouped by model line (newest first within a line, as the catalog is sorted).
 * The saved id stays selectable even when the catalog has not loaded or no longer lists it.
 */
export function claudeModelOptions(
  models: readonly AnthropicCatalogModel[],
  currentId: string,
): { id: string; label: string; group?: string; title?: string }[] {
  const rows = [...models]
    .sort((a, b) => lineRank(a.line) - lineRank(b.line))
    .map((m) => ({
      id: m.id,
      label: m.deprecated ? `${m.displayName} (deprecated)` : m.displayName,
      group: claudeLineLabel(m.line),
      title: m.id,
    }));
  const id = currentId.trim();
  if (id && !rows.some((row) => row.id === id)) {
    rows.unshift({ id, label: id, group: 'Current', title: id });
  }
  return rows;
}

/** ``1000000`` → ``1M``, ``200000`` → ``200K``; empty for unknown. */
export function formatClaudeTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return '';
  }
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1000)}K`;
}

/** ISO timestamp → ``Mar 2026``; empty when missing or unparsable. */
export function formatClaudeDate(iso: string | undefined): string {
  if (!iso) {
    return '';
  }
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}
