import { describe, expect, it } from 'vitest';
import { computeVirtualRange } from '../../../utils/virtual-scroll-range';
import { CHAT_MIN_FALLBACK_ROW, estimateChatRowHeight, sumHeights } from './chat-box-virtual';

describe('chat-box-virtual', () => {
  it('estimateChatRowHeight grows with user text length', () => {
    const short = estimateChatRowHeight({ kind: 'user', msg: { text: 'hi' } }, 0.9);
    const long = estimateChatRowHeight(
      { kind: 'user', msg: { text: 'x'.repeat(500) } },
      0.9,
    );
    expect(long).toBeGreaterThan(short);
  });

  it('computeVirtualRange includes buffer around viewport', () => {
    const heights = [50, 50, 50, 50, 50, 50, 50, 50];
    const { start, end } = computeVirtualRange(heights, 100, 80, 40, CHAT_MIN_FALLBACK_ROW);
    expect(start).toBeLessThan(3);
    expect(end).toBeGreaterThan(3);
    expect(end - start).toBeLessThanOrEqual(heights.length);
  });

  it('sumHeights sums a slice', () => {
    expect(sumHeights([10, 20, 30], 0, 2)).toBe(30);
    expect(sumHeights([10, 20, 30], 1, 3)).toBe(50);
  });

  it('estimateChatRowHeight includes collapsed thought/tool pills for persisted timeline', () => {
    const base = estimateChatRowHeight(
      {
        kind: 'assistant-turn',
        assistant: { text: 'Short.', toolStreams: [], reasoningStreams: [] },
        chainGroups: [],
        artifacts: [],
      },
      0.9,
    );
    const withTimeline = estimateChatRowHeight(
      {
        kind: 'assistant-turn',
        assistant: {
          text: 'Short.',
          auxiliaryStreamTimeline: [{ streamTag: 'reasoning', label: 'R', text: 'a' }],
        },
        chainGroups: [],
        artifacts: [],
      },
      0.9,
    );
    expect(withTimeline).toBeGreaterThan(base);
  });
});
