import type { ToolTrailPillState } from '@shared/index';

/** Keep the brief body visible below this many display lines; 3+ collapse into the pill. */
export const BRIEF_INLINE_LINE_LIMIT = 3;

/** Approx. characters per wrapped line at the brief preview's mono size. */
export const BRIEF_WRAP_CHARS = 72;

export function briefPillLabel(_live: boolean, _active: boolean): string {
  return 'reasoning';
}

export function briefPillState(live: boolean, active: boolean): ToolTrailPillState {
  return live && active ? 'running' : 'complete';
}

/**
 * Display-line count for a Clara brief: explicit newlines plus wrap of long rows.
 * Empty / whitespace-only text is 0.
 */
export function briefLineCount(text: string): number {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return 0;
  }
  let count = 0;
  for (const row of normalized.split('\n')) {
    count += Math.max(1, Math.ceil(row.length / BRIEF_WRAP_CHARS));
  }
  return count;
}

/** True when the brief is short enough to stay rendered instead of collapsing to a chip. */
export function isShortBrief(text: string): boolean {
  const n = briefLineCount(text);
  return n > 0 && n < BRIEF_INLINE_LINE_LIMIT;
}

/**
 * Short briefs stay in the preview pane after streaming unless the user collapsed them.
 * Longer briefs always condense into the reasoning chip.
 */
export function shouldKeepBriefRendered(text: string, userOverride: boolean | null): boolean {
  if (userOverride === false) {
    return false;
  }
  return isShortBrief(text);
}

/** User override wins; short briefs stay open; otherwise expand only while live+active. */
export function resolveBriefPillExpanded(
  live: boolean,
  active: boolean,
  userOverride: boolean | null,
  text = '',
): boolean {
  if (userOverride !== null) {
    return userOverride;
  }
  if (isShortBrief(text)) {
    return true;
  }
  return live && active;
}

/** Live streaming preview pane; user collapse hides it in favor of the chip. */
export function isBriefStreamingPreview(
  live: boolean,
  active: boolean,
  userOverride: boolean | null,
): boolean {
  if (userOverride === false) {
    return false;
  }
  return live && active;
}
