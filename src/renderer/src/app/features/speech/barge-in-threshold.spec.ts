import { describe, expect, it } from 'vitest';
import {
  BARGE_IN_MAX_THRESHOLD,
  computeBargeThreshold,
  micExceedsBargeThreshold,
  SILENCE_RMS,
} from './barge-in-threshold';

describe('computeBargeThreshold', () => {
  it('uses silence floor when assistant playback is idle', () => {
    expect(computeBargeThreshold(0)).toBe(SILENCE_RMS);
    expect(computeBargeThreshold(0.001)).toBe(SILENCE_RMS);
  });

  it('raises threshold when assistant playback is active', () => {
    const playback = 0.05;
    const threshold = computeBargeThreshold(playback);
    expect(threshold).toBeGreaterThan(SILENCE_RMS);
    expect(threshold).toBeCloseTo(0.05 * 1.2 + 0.008, 5);
  });

  it('caps playback-derived threshold for headphone-friendly barge-in', () => {
    expect(computeBargeThreshold(0.5)).toBe(BARGE_IN_MAX_THRESHOLD);
    expect(computeBargeThreshold(1)).toBe(BARGE_IN_MAX_THRESHOLD);
  });
});

describe('micExceedsBargeThreshold', () => {
  it('does not barge when mic is only at silence floor with loud playback', () => {
    expect(micExceedsBargeThreshold(0.02, 0.08)).toBe(false);
  });

  it('barges when mic exceeds playback-scaled threshold', () => {
    expect(micExceedsBargeThreshold(0.12, 0.05)).toBe(true);
  });

  it('barges at normal speaking level when assistant is idle', () => {
    expect(micExceedsBargeThreshold(0.02, 0)).toBe(true);
  });

  it('barges at moderate mic level when playback cap applies (headphones)', () => {
    expect(micExceedsBargeThreshold(0.08, 0.4)).toBe(false);
    expect(micExceedsBargeThreshold(0.11, 0.4)).toBe(true);
  });
});
