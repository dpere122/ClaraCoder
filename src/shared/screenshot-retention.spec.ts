import { describe, expect, it } from 'vitest';
import { DEFAULT_SCREENSHOT_RETENTION, normalizeScreenshotRetention } from './screenshot-retention';

describe('screenshot retention policy', () => {
  it.each([undefined, null, [], true, '30', {}])('defaults invalid or absent settings %j', (value) => {
    expect(normalizeScreenshotRetention(value)).toEqual(DEFAULT_SCREENSHOT_RETENTION);
  });

  it('clamps finite numbers, rounds integers and keeps downscaling before expiry', () => {
    expect(normalizeScreenshotRetention({
      downscaleAfterDays: 999, retentionDays: 1, maxWidth: 9999, maxStorageMiB: 1, maxImages: 5000,
    })).toEqual({ downscaleAfterDays: 1, retentionDays: 2, maxWidth: 1920, maxStorageMiB: 10, maxImages: 2000 });
    expect(normalizeScreenshotRetention({
      downscaleAfterDays: -1, retentionDays: 999, maxWidth: 1, maxStorageMiB: 9999, maxImages: -1,
    })).toEqual({ downscaleAfterDays: 1, retentionDays: 365, maxWidth: 320, maxStorageMiB: 1024, maxImages: 10 });
    expect(normalizeScreenshotRetention({ retentionDays: 20.7, maxImages: 15.2 }).retentionDays).toBe(21);
  });

  it('does not coerce strings, NaN or infinity, or mutate defaults', () => {
    expect(normalizeScreenshotRetention({
      downscaleAfterDays: NaN, retentionDays: Infinity, maxWidth: '320', maxStorageMiB: null, maxImages: -Infinity,
    })).toEqual(DEFAULT_SCREENSHOT_RETENTION);
    const first = normalizeScreenshotRetention(undefined);
    first.maxImages = 10;
    expect(normalizeScreenshotRetention(undefined).maxImages).toBe(200);
    expect(Object.isFrozen(DEFAULT_SCREENSHOT_RETENTION)).toBe(true);
  });
});
