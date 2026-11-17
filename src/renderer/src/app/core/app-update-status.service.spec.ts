import { TestBed } from '@angular/core/testing';
import type { AppReleaseListResult, AppReleaseSummary } from '@shared/app-updater';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppUpdateStatusService } from './app-update-status.service';
import { ElectronService } from './electron.service';

function release(version: string): AppReleaseSummary {
  return {
    version,
    tag: `v${version}`,
    name: `v${version}`,
    notes: '',
    prerelease: version.includes('-'),
    publishedAt: null,
    htmlUrl: '',
    installer: { fileName: `ClaraCoder-${version}.exe`, size: 1 },
  };
}

function listed(currentVersion: string, versions: readonly string[]): AppReleaseListResult {
  return { ok: true, currentVersion, releases: versions.map(release) };
}

/** Lets the startup check (or any pending one) finish. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

function setup(list: () => Promise<AppReleaseListResult>) {
  const electron = {
    isElectron: true,
    appVersion: vi.fn(async () => '0.2.0'),
    updaterListReleases: vi.fn(list),
  };
  TestBed.configureTestingModule({ providers: [{ provide: ElectronService, useValue: electron }] });
  const service = TestBed.inject(AppUpdateStatusService);
  return { service, electron };
}

describe('AppUpdateStatusService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('flags a newer installable release with a tooltip naming it', async () => {
    const { service, electron } = setup(async () => listed('0.2.0', ['0.1.0', '0.3.0']));
    service.start();
    await settle();
    expect(electron.updaterListReleases).toHaveBeenCalledWith(false);
    expect(service.updateAvailable()).toBe(true);
    expect(service.latestUpdate()?.version).toBe('0.3.0');
    expect(service.tooltip()).toBe('Update available: v0.3.0 — open Updates');
  });

  it('stays clear when the running version is the newest', async () => {
    const { service } = setup(async () => listed('0.3.0', ['0.2.0', '0.3.0']));
    service.start();
    await settle();
    expect(service.updateAvailable()).toBe(false);
    expect(service.tooltip()).toBe('Open Updates');
  });

  it('falls back to the app version when the result has none', async () => {
    const { service, electron } = setup(async () => listed('', ['0.3.0']));
    await service.refresh();
    expect(electron.appVersion).toHaveBeenCalled();
    expect(service.latestUpdate()?.version).toBe('0.3.0');
  });

  it('stays clear when the bridge has no release list', async () => {
    TestBed.configureTestingModule({
      providers: [{ provide: ElectronService, useValue: { isElectron: true, appVersion: async () => '0.2.0' } }],
    });
    const service = TestBed.inject(AppUpdateStatusService);
    expect(() => service.start()).not.toThrow();
    await settle();
    expect(service.updateAvailable()).toBe(false);
  });

  it('keeps the last known state when a check fails or returns an error', async () => {
    const { service, electron } = setup(async () => listed('0.2.0', ['0.3.0']));
    await service.refresh();
    expect(service.updateAvailable()).toBe(true);

    electron.updaterListReleases.mockRejectedValueOnce(new Error('offline'));
    await expect(service.refresh()).resolves.toBeUndefined();
    expect(service.updateAvailable()).toBe(true);

    electron.updaterListReleases.mockResolvedValueOnce({
      ok: false,
      currentVersion: '0.2.0',
      releases: [],
      error: 'rate limited',
    });
    await service.refresh();
    expect(service.updateAvailable()).toBe(true);
  });

  it('starts once and re-checks every 10 minutes', async () => {
    vi.useFakeTimers();
    try {
      const { service, electron } = setup(async () => listed('0.2.0', []));
      service.start();
      service.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(electron.updaterListReleases).toHaveBeenCalledTimes(1);

      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(AppUpdateStatusService.REFRESH_INTERVAL_MS - 1);
      expect(electron.updaterListReleases).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(electron.updaterListReleases).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(AppUpdateStatusService.REFRESH_INTERVAL_MS);
      expect(electron.updaterListReleases).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
