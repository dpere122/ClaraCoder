import { computeVirtualRange, sumHeights } from '../../../utils/virtual-scroll-range';

/** Persisted rows above this count use windowed rendering (off-screen rows are not in the DOM). */
export const CHAT_VIRTUAL_THRESHOLD = 48;

/** Extra pixels above/below the viewport to keep mounted for smooth scroll. */
export const CHAT_VIRTUAL_PIXEL_BUFFER = 720;

/** Fallback row height when a slot has not been measured yet (virtual range math). */
export const CHAT_MIN_FALLBACK_ROW = 52;

const MIN_ROW = CHAT_MIN_FALLBACK_ROW;

export { sumHeights, computeVirtualRange };

/** Structural copy of display rows used for height estimation (avoids circular imports with chat-box.ts). */
export type ChatRowHeightInput =
  | { kind: 'user'; msg: { text: string; structuredContent?: readonly Readonly<Record<string, unknown>>[] } }
  | {
      kind: 'assistant-turn';
      assistant: {
        text?: string;
        planner?: { steps: readonly unknown[] };
        toolStreams?: readonly unknown[] | null;
        reasoningStreams?: readonly unknown[] | null;
        moeStreams?: readonly unknown[] | null;
        auxiliaryStreamTimeline?: readonly unknown[] | null;
      } | null;
      chainGroups: readonly { rows: readonly unknown[] }[];
      artifacts: readonly { role: string }[];
    };

/**
 * Rough height guess from message shape so the scrollbar and window stay usable before DOM measure.
 * Tuned for rem-based chat font and typical bubble padding (see chat-box.css).
 */
export function estimateChatRowHeight(row: ChatRowHeightInput, fontSizeRem: number): number {
  const linePx = fontSizeRem * 16 * 1.5;
  const bubblePad = 28;

  if (row.kind === 'user') {
    const cpl = 44;
    const lines = Math.max(1, Math.ceil(row.msg.text.length / cpl));
    let imageCount = 0;
    for (const part of row.msg.structuredContent ?? []) {
      if (String((part as { type?: unknown }).type ?? '') === 'image_url') {
        imageCount++;
      }
    }
    // Inline image thumbnails cap at 12rem tall (see chat-box.css) plus chip gap.
    const attachmentsPx = imageCount > 0 ? 192 + 8 : 0;
    return Math.max(MIN_ROW, Math.round(bubblePad + lines * linePx + attachmentsPx));
  }

  let h = bubblePad + 6;
  const planner = row.assistant?.planner;
  if (planner && planner.steps.length > 0) {
    h += 72 + planner.steps.length * 44;
    if (row.artifacts.some((a) => a.role === 'plan_confirm')) {
      h += 52;
    }
  }
  const timeline = row.assistant?.auxiliaryStreamTimeline?.length ?? 0;
  if (timeline > 0) {
    h += timeline * 28;
  } else {
    const streams = row.assistant?.toolStreams?.length ?? 0;
    if (streams > 0) {
      h += streams * Math.min(200, 80 + linePx * 3);
    }
    const reasoningStreams =
      row.assistant?.reasoningStreams?.length ?? row.assistant?.moeStreams?.length ?? 0;
    if (reasoningStreams > 0) {
      h += reasoningStreams * Math.min(220, 56 + linePx * 4);
    }
  }
  for (const art of row.artifacts) {
    if (art.role === 'diff' || art.role === 'delete_confirm' || art.role === 'copy_confirm' || art.role === 'accept_command') {
      h += 40;
      break;
    }
  }
  const textLen = row.assistant?.text?.length ?? 0;
  h += Math.min(2800, textLen) * 0.11;
  return Math.max(MIN_ROW, Math.round(h));
}
