/** Portable retention policy shared by settings, the capture store and renderer. */
export interface ScreenshotRetentionSettings {
  downscaleAfterDays: number;
  retentionDays: number;
  maxWidth: number;
  maxStorageMiB: number;
  maxImages: number;
}

export const DEFAULT_SCREENSHOT_RETENTION: Readonly<ScreenshotRetentionSettings> = Object.freeze({
  downscaleAfterDays: 7,
  retentionDays: 30,
  maxWidth: 1280,
  maxStorageMiB: 100,
  maxImages: 200,
});

/** Invalid fields use defaults; finite numeric fields are rounded and clamped. */
export function normalizeScreenshotRetention(value: unknown): ScreenshotRetentionSettings {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const bounded = (key: keyof ScreenshotRetentionSettings, min: number, max: number): number => {
    const number = input[key];
    return typeof number === 'number' && Number.isFinite(number)
      ? Math.min(max, Math.max(min, Math.round(number))) : DEFAULT_SCREENSHOT_RETENTION[key];
  };
  const retentionDays = bounded('retentionDays', 2, 365);
  return {
    downscaleAfterDays: Math.min(bounded('downscaleAfterDays', 1, 364), retentionDays - 1),
    retentionDays,
    maxWidth: bounded('maxWidth', 320, 1920),
    maxStorageMiB: bounded('maxStorageMiB', 10, 1024),
    maxImages: bounded('maxImages', 10, 2000),
  };
}

export interface ScreenshotStorageStats {
  bytes: number;
  imageCount: number;
  reducedCount: number;
  maxBytes: number;
  maxImages: number;
}

export type ScreenshotAssetStatus = {
  state: 'available' | 'expired' | 'missing';
  reason?: 'age' | 'storage' | 'cleared';
  retentionDays?: number;
};
