import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SCREENSHOT_RETENTION, type ScreenshotRetentionSettings } from '@shared/screenshot-retention';
import { ElectronService } from '../../../core/electron.service';
import { ThemedConfirmDialogService } from '../../../shared/themed-confirm-dialog/themed-confirm-dialog.service';
import { SettingsStore } from '../settings/settings-store';
import { SettingsTools } from './settings-tools';

const stats = { bytes: 1048576, imageCount: 4, reducedCount: 2, maxBytes: 104857600, maxImages: 200 };

function setup() {
  const store = {
    screenshotRetention: signal({ ...DEFAULT_SCREENSHOT_RETENTION }),
    markSettingsDirty: vi.fn(),
    onScreenshotRetentionChange: vi.fn(),
    activeSubTabId: () => 'editTools',
    editToolsMode: () => 'standard',
    enableAgentFormatters: () => false,
    allowStagingOverlayCommands: () => false,
    exposeAllWorkspaceFiles: () => false,
    commandLineExplainStep: () => false,
    allowWebAccess: () => false,
    webSearchProvider: () => 'auto',
    webSearchEngines: () => [],
    webSearchUserAgent: () => '',
    webSearchCooldownSeconds: () => 300,
    searxngBaseUrl: () => '',
    extraUserPath: () => '',
  };
  store.onScreenshotRetentionChange.mockImplementation((key: keyof ScreenshotRetentionSettings, raw: string | number | null) => {
    SettingsStore.prototype.onScreenshotRetentionChange.call(store as unknown as SettingsStore, key, raw);
  });
  const electron = {
    getScreenshotStorageStats: vi.fn().mockResolvedValue({ ok: true, stats }),
    runScreenshotCleanup: vi.fn().mockResolvedValue({ ok: true, stats: { ...stats, imageCount: 2 } }),
    clearScreenshots: vi.fn().mockResolvedValue({ ok: true, stats: { ...stats, imageCount: 0, reducedCount: 0, bytes: 0 } }),
  };
  const confirm = { open: vi.fn().mockResolvedValue('cancel') };
  TestBed.configureTestingModule({
    imports: [SettingsTools],
    providers: [
      { provide: SettingsStore, useValue: store },
      { provide: ElectronService, useValue: electron },
      { provide: ThemedConfirmDialogService, useValue: confirm },
    ],
  });
  const fixture = TestBed.createComponent(SettingsTools);
  return { fixture, component: fixture.componentInstance, store, electron, confirm };
}

beforeEach(() => TestBed.resetTestingModule());

describe('screenshot retention Tools settings', () => {
  it('renders all five controls and usage even with web access off', async () => {
    const { fixture, electron } = setup();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const section = (fixture.nativeElement as HTMLElement).querySelector('.screenshot-retention')!;
    expect(section.querySelectorAll('input[type="number"]')).toHaveLength(5);
    expect(section.textContent).toContain('7 days');
    expect(section.textContent).toContain('30 days');
    expect(section.textContent).toContain('4 / 200 images');
    expect(section.textContent).toContain('2 reduced');
    expect(section.textContent).toContain('1.0 / 100.0 MiB');
    expect(electron.getScreenshotStorageStats).toHaveBeenCalledOnce();
  });

  it('updates bounded retention drafts and marks settings dirty', () => {
    const { store } = setup();
    store.onScreenshotRetentionChange('maxWidth', 9999);
    expect(store.screenshotRetention().maxWidth).toBe(1920);
    store.onScreenshotRetentionChange('retentionDays', 2);
    expect(store.screenshotRetention().downscaleAfterDays).toBe(1);
    expect(store.screenshotRetention().retentionDays).toBe(2);
    expect(store.markSettingsDirty).toHaveBeenCalledTimes(2);
    store.onScreenshotRetentionChange('maxWidth', '');
    store.onScreenshotRetentionChange('maxWidth', null);
    store.onScreenshotRetentionChange('maxWidth', 'not a number');
    expect(store.markSettingsDirty).toHaveBeenCalledTimes(2);
  });

  it('merges policy patches into the existing settings draft', () => {
    const { store } = setup();
    store.screenshotRetention.set({ ...DEFAULT_SCREENSHOT_RETENTION, retentionDays: 90 });
    SettingsStore.prototype.updateWorkspaceTools.call(store as unknown as SettingsStore, {
      screenshotRetention: { maxImages: 500 } as ScreenshotRetentionSettings,
    });
    expect(store.screenshotRetention()).toEqual({ ...DEFAULT_SCREENSHOT_RETENTION, retentionDays: 90, maxImages: 500 });
    expect(store.markSettingsDirty).toHaveBeenCalledOnce();
  });

  it('refreshes storage and runs cleanup without discarding an unsaved draft', async () => {
    const { component, store, electron } = setup();
    const draft = { ...DEFAULT_SCREENSHOT_RETENTION, maxImages: 600, retentionDays: 90 };
    store.screenshotRetention.set(draft);
    await component.refreshScreenshotStorage();
    await component.runScreenshotCleanup();
    expect(component.screenshotStats()?.imageCount).toBe(2);
    expect(store.screenshotRetention()).toBe(draft);
    expect(store.markSettingsDirty).not.toHaveBeenCalled();
    expect(electron.runScreenshotCleanup).toHaveBeenCalledExactlyOnceWith();
  });

  it('requires confirmation before clearing and refreshes usage from the result', async () => {
    const { component, electron, confirm } = setup();
    await component.clearScreenshots();
    expect(electron.clearScreenshots).not.toHaveBeenCalled();
    expect(confirm.open.mock.calls[0][0].detail).toContain('Conversation text is kept');
    confirm.open.mockResolvedValueOnce('confirm');
    await component.clearScreenshots();
    expect(electron.clearScreenshots).toHaveBeenCalledExactlyOnceWith();
    expect(component.screenshotStats()?.imageCount).toBe(0);
  });

  it('keeps errors visible and preserves last known usage', async () => {
    const { component, fixture, electron } = setup();
    fixture.detectChanges();
    await fixture.whenStable();
    electron.runScreenshotCleanup.mockResolvedValueOnce({ ok: false, error: 'Cleanup failed' });
    await component.runScreenshotCleanup();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('[role="alert"]')?.textContent).toContain('Cleanup failed');
    expect(component.screenshotStats()).toEqual(stats);
    expect(component.screenshotStorageBusy()).toBe(false);
    electron.getScreenshotStorageStats.mockRejectedValueOnce(new Error('Stats unavailable'));
    await component.refreshScreenshotStorage();
    expect(component.screenshotStorageError()).toBe('Stats unavailable');
    expect(component.screenshotStorageBusy()).toBe(false);
  });

  it('does not start another operation while storage is busy', async () => {
    const { component, electron, confirm } = setup();
    component.screenshotStorageBusy.set(true);
    await component.refreshScreenshotStorage();
    await component.runScreenshotCleanup();
    await component.clearScreenshots();
    expect(electron.getScreenshotStorageStats).not.toHaveBeenCalled();
    expect(electron.runScreenshotCleanup).not.toHaveBeenCalled();
    expect(confirm.open).not.toHaveBeenCalled();
  });
});
