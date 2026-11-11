import type { LlmOptimizationPreset, LlmReasoningEffort, LmStudioModelCard } from '@shared/index';

/** Round sizes offered for the context length; anything above the model's max is dropped. */
const CONTEXT_STEPS = [8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576];

const THINKING_LABELS: Record<string, string> = { off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High' };

export function lmStudioIsEmbedding(card: Pick<LmStudioModelCard, 'type'>): boolean {
  return /embed/i.test(card.type);
}

export function lmStudioIsLoaded(card: Pick<LmStudioModelCard, 'state'>): boolean {
  return card.state === 'loaded' || card.state === 'loading';
}

export function lmStudioModelName(card: Pick<LmStudioModelCard, 'id' | 'displayName'>): string {
  return card.displayName || card.id;
}

/** ``262144`` reads as ``256K``. Context sizes are powers of two, so K is 1024 here. */
export function formatLmStudioTokens(tokens: number): string {
  if (tokens >= 1048576 && tokens % 1048576 === 0) {
    return `${tokens / 1048576}M`;
  }
  if (tokens >= 1024 && tokens % 1024 === 0) {
    return `${tokens / 1024}K`;
  }
  return tokens.toLocaleString();
}

export function lmStudioContextOptions(maxContext: number): { id: string; label: string }[] {
  const steps = maxContext > 0 ? CONTEXT_STEPS.filter((n) => n < maxContext) : CONTEXT_STEPS;
  return [
    ...steps.map((n) => ({ id: String(n), label: formatLmStudioTokens(n) })),
    ...(maxContext > 0 ? [{ id: String(maxContext), label: `${formatLmStudioTokens(maxContext)} (model max)` }] : []),
  ];
}

/** Only the thinking settings this model reports; empty when it has none to choose from. */
export function lmStudioThinkingOptions(card: Pick<LmStudioModelCard, 'reasoningOptions'> | null): { id: string; label: string }[] {
  return (card?.reasoningOptions ?? []).map((id) => ({ id, label: THINKING_LABELS[id] ?? id }));
}

/** Which thinking option the saved fields amount to on this model. */
export function lmStudioThinkingValue(
  card: Pick<LmStudioModelCard, 'reasoningOptions' | 'reasoningDefault'> | null,
  thinkingMode: string | undefined,
  reasoningEffort: string | undefined,
): string {
  const options = card?.reasoningOptions ?? [];
  if (thinkingMode === 'off' && options.includes('off')) {
    return 'off';
  }
  if (reasoningEffort && options.includes(reasoningEffort)) {
    return reasoningEffort;
  }
  if (thinkingMode === 'on' && options.includes('on')) {
    return 'on';
  }
  return card?.reasoningDefault ?? options[0] ?? '';
}

/** The saved fields for a thinking option. Off and on are modes; the rest are effort levels. */
export function lmStudioThinkingPatch(value: string): { thinkingMode: 'on' | 'off'; reasoningEffort: LlmReasoningEffort } {
  if (value === 'off') {
    return { thinkingMode: 'off', reasoningEffort: '' };
  }
  return { thinkingMode: 'on', reasoningEffort: (value === 'on' ? '' : value) as LlmReasoningEffort };
}

/** The Clara profile written for this model's architecture, if there is one. */
export function lmStudioSuggestedProfile(card: Pick<LmStudioModelCard, 'arch'> | null): LlmOptimizationPreset | null {
  const arch = (card?.arch ?? '').toLowerCase();
  if (arch.startsWith('qwen')) {
    return 'qwen';
  }
  return arch.startsWith('gemma') ? 'gemma' : null;
}
