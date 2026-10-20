import { describe, expect, it } from 'vitest';
import { TurnRateTracker, turnGenerationSummary } from './generation-rate';

describe('TurnRateTracker', () => {
  it('estimates a live rate from streamed chars once the window spans enough time', () => {
    const tracker = new TurnRateTracker(4);
    // 40 chars every 100 ms at 4 chars/token = 100 tok/s.
    let changed = false;
    for (let t = 0; t <= 500; t += 100) {
      changed = tracker.onChunk(40, t) || changed;
    }
    expect(changed).toBe(true);
    expect(tracker.live?.estimated).toBe(true);
    expect(tracker.live?.tokensPerSecond).toBeCloseTo(100, 5);
  });

  it('republishes an estimate at most once a second', () => {
    const tracker = new TurnRateTracker(4);
    const published: number[] = [];
    for (let t = 0; t <= 2500; t += 100) {
      if (tracker.onChunk(40, t)) published.push(t);
    }
    expect(published).toEqual([300, 1300, 2300]);
  });

  it('leaves stalls inside the window out of the estimate', () => {
    const tracker = new TurnRateTracker(4);
    for (let t = 0; t <= 300; t += 100) tracker.onChunk(40, t);
    // A 3 s tool run, then decoding resumes at the same 100 tok/s.
    for (let t = 3300; t <= 4400; t += 100) tracker.onChunk(40, t);
    expect(tracker.live?.tokensPerSecond).toBeCloseTo(100, 5);
  });

  it('switches to the exact rate when usage arrives and sums it across model calls', () => {
    const tracker = new TurnRateTracker(4);
    tracker.onChunk(400, 0);
    expect(tracker.onUsage(100, 2000, 2000)).toBe(4);
    expect(tracker.live).toEqual({ tokensPerSecond: 50, estimated: false });
    tracker.onUsage(300, 2000, 9000);
    expect(tracker.live).toEqual({ tokensPerSecond: 100, estimated: false });
    expect(tracker.stats()).toEqual({ outputTokens: 400, generationMs: 4000 });
  });

  it('falls back to an estimate from decode time when the provider sends no usage', () => {
    const tracker = new TurnRateTracker(4);
    tracker.onChunk(80, 0);
    tracker.onChunk(80, 500);
    tracker.onChunk(80, 1000);
    // A tool run: the long gap is not counted as decode time.
    tracker.onChunk(80, 6000);
    tracker.onChunk(80, 6500);
    expect(tracker.stats()).toEqual({ outputTokens: 100, generationMs: 1500, estimated: true });
  });

  it('adds the wall-clock turn time when the turn has a start time', () => {
    const tracker = new TurnRateTracker(4, 1000);
    tracker.onChunk(400, 2000);
    tracker.onUsage(100, 1000, 3000);
    // Tool run, then the final answer step.
    tracker.onUsage(100, 1000, 20_000);
    expect(tracker.stats(21_000)).toEqual({ outputTokens: 200, generationMs: 2000, turnMs: 20_000 });
    expect(tracker.stats()).toEqual({ outputTokens: 200, generationMs: 2000 });
  });

  it('reports nothing for a turn that streamed nothing', () => {
    expect(new TurnRateTracker(4).stats()).toBeUndefined();
  });
});

describe('turnGenerationSummary', () => {
  it('formats rate, token count and decode time', () => {
    expect(turnGenerationSummary({ outputTokens: 1234, generationMs: 29_000 })).toEqual(
      expect.objectContaining({ rate: '42.6 tok/s', detail: '1,234 tokens · 29s' }),
    );
    expect(turnGenerationSummary({ outputTokens: 341, generationMs: 2657 })?.rate).toBe('128 tok/s');
    expect(turnGenerationSummary({ outputTokens: 9000, generationMs: 125_000 })?.detail).toBe('9,000 tokens · 2m 05s');
  });

  it('shows the whole turn time while the rate stays on decode time', () => {
    const summary = turnGenerationSummary({ outputTokens: 1234, generationMs: 29_000, turnMs: 95_000 });
    expect(summary?.rate).toBe('42.6 tok/s');
    expect(summary?.detail).toBe('1,234 tokens · 1m 35s');
    expect(summary?.title).toMatch(/^Turn took 1m 35s\. 1,234 tokens generated in 29s/);
  });

  it('marks estimates and skips stats without decode time', () => {
    const summary = turnGenerationSummary({ outputTokens: 50, generationMs: 1000, estimated: true });
    expect(summary?.rate).toBe('~50.0 tok/s');
    expect(summary?.detail).toBe('~50 tokens · 1.0s');
    expect(turnGenerationSummary({ outputTokens: 50, generationMs: 0 })).toBeNull();
  });
});
