import type { ConversationMessage, StreamPart } from '@shared/index';
import { buildContextCapacitySnapshot, estimateTranscriptContextTokens } from './context-capacity.utils';

describe('buildContextCapacitySnapshot', () => {
  it('uses the configured context window and counts transcript content', () => {
    const messages: ConversationMessage[] = [
      { role: 'user', text: 'Explain the current architecture.' },
      { role: 'assistant', text: 'Here is a short summary.' },
    ];
    const streamingParts: StreamPart[] = [{ streamTag: 'agent', label: 'Clara', text: 'Working on it now.' }];

    const snapshot = buildContextCapacitySnapshot({
      connection: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        contextWindowTokens: 8_000,
      },
      messages,
      streamingParts,
      workspaceContextText: 'src/\n  app/\n    shell.ts',
    });

    expect(snapshot.maxTokens).toBe(8_000);
    expect(snapshot.usedTokens).toBeGreaterThan(0);
    expect(snapshot.remainingTokens).toBe(8_000 - snapshot.usedTokens);
    expect(snapshot.usedPercentage).toBeGreaterThan(0);
    expect(snapshot.measuredFromApi).toBe(false);
  });

  it('falls back to model inference when no explicit context window is set', () => {
    const snapshot = buildContextCapacitySnapshot({
      connection: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        contextWindowTokens: 0,
      },
      messages: [],
      streamingParts: [],
      workspaceContextText: '',
    });

    expect(snapshot.maxTokens).toBe(128_000);
    expect(snapshot.usedTokens).toBe(0);
    expect(snapshot.remainingTokens).toBe(128_000);
    expect(snapshot.usedPercentage).toBe(0);
    expect(snapshot.measuredFromApi).toBe(false);
  });

  it('prefers measured prompt tokens from the chat API when provided', () => {
    const snapshot = buildContextCapacitySnapshot({
      connection: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        contextWindowTokens: 128_000,
      },
      messages: [{ role: 'user', text: 'x'.repeat(4000) }],
      streamingParts: [],
      workspaceContextText: '',
      measuredPromptTokens: 42,
      measuredBaselineFallbackTokens: estimateTranscriptContextTokens({
        messages: [{ role: 'user', text: 'x'.repeat(4000) }],
        streamingParts: [],
        workspaceContextText: '',
      }),
    });

    expect(snapshot.usedTokens).toBe(42);
    expect(snapshot.measuredFromApi).toBe(true);
  });

  it('adds transcript growth above the baseline after a measurement', () => {
    const messages: ConversationMessage[] = [{ role: 'user', text: 'hello' }];
    const baselineParts: StreamPart[] = [];
    const grownParts: StreamPart[] = [
      { streamTag: 'tool', label: 'read', text: 'y'.repeat(400) },
    ];
    const baseline = estimateTranscriptContextTokens({
      messages,
      streamingParts: baselineParts,
      workspaceContextText: '',
    });
    const grown = estimateTranscriptContextTokens({
      messages,
      streamingParts: grownParts,
      workspaceContextText: '',
    });
    expect(grown).toBeGreaterThan(baseline);

    const snapshot = buildContextCapacitySnapshot({
      connection: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        contextWindowTokens: 128_000,
      },
      messages,
      streamingParts: grownParts,
      workspaceContextText: '',
      measuredPromptTokens: 10_000,
      measuredBaselineFallbackTokens: baseline,
    });

    expect(snapshot.usedTokens).toBe(10_000 + (grown - baseline));
    expect(snapshot.measuredFromApi).toBe(true);
  });

  it('does not subtract when transcript estimate is below the baseline (e.g. UI still shows full tools)', () => {
    const snapshot = buildContextCapacitySnapshot({
      connection: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        contextWindowTokens: 128_000,
      },
      messages: [{ role: 'user', text: 'hi' }],
      streamingParts: [{ streamTag: 'tool', label: 'read', text: 'z'.repeat(800) }],
      workspaceContextText: '',
      measuredPromptTokens: 20_000,
      // Baseline as if captured when the stream was larger; UI estimate can stay high after checkpoint compaction.
      measuredBaselineFallbackTokens: 50_000,
    });

    expect(snapshot.usedTokens).toBe(20_000);
  });
});
