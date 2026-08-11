/**
 * Tests for security/menu-openexternal — recent-conversations limit clamp.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../conversations-db', () => ({ getRecentConversationSummaries: vi.fn(() => []) }));

import { clampRecentLimit } from './recent-conversations';

describe('clampRecentLimit', () => {
  it('clamps to the max (200)', () => {
    expect(clampRecentLimit(1000)).toBe(200);
  });

  it('floors fractional values', () => {
    expect(clampRecentLimit(12.9)).toBe(12);
  });

  it('defaults to 50 for non-positive / non-numeric', () => {
    expect(clampRecentLimit(0)).toBe(50);
    expect(clampRecentLimit(-5)).toBe(50);
    expect(clampRecentLimit(Number.NaN)).toBe(50);
    expect(clampRecentLimit(Number.POSITIVE_INFINITY)).toBe(50);
  });

  it('passes a sane positive value through (floored)', () => {
    expect(clampRecentLimit(25)).toBe(25);
    expect(clampRecentLimit(200)).toBe(200);
  });
});
