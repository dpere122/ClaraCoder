import { signal, type Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NgxSpinnerService } from 'ngx-spinner';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultLspServersSettings } from '@shared/lsp-settings';
import type { SettingsStore as SettingsStoreClass } from './settings-store';

let SettingsStore: Type<SettingsStoreClass>;
let ElectronService: Type<unknown>;
let ThemeEngineService: Type<unknown>;
let ThemedConfirmDialogService: Type<unknown>;
let ThemedPromptDialogService: Type<unknown>;
let SettingsThemesStore: Type<unknown>;

beforeAll(async () => {
  // Another suite may already have loaded a chunk before its lazy imports initialized, which leaves
  // the store's class fields undefined. Start a fresh module graph, as tutorial-source-flow.spec does.
  vi.resetModules();
  await import('@shared/index');
  await import('@shared/theme');
  await import('./settings-tabs');
  ({ ElectronService } = await import('../../../core/electron.service'));
  ({ ThemeEngineService } = await import('../../../core/theme/theme-engine.service'));
  ({ ThemedConfirmDialogService } = await import('../../../shared/themed-confirm-dialog/themed-confirm-dialog.service'));
  ({ ThemedPromptDialogService } = await import('../../../shared/themed-prompt-dialog/themed-prompt-dialog.service'));
  ({ SettingsThemesStore } = await import('../settings-themes/settings-themes-store'));
  ({ SettingsStore } = await import('./settings-store'));
});

function setup(depsList = vi.fn()): SettingsStoreClass {
  TestBed.configureTestingModule({
    providers: [
      SettingsStore,
      { provide: ElectronService, useValue: { depsList } },
      { provide: ThemedConfirmDialogService, useValue: {} },
      { provide: ThemedPromptDialogService, useValue: {} },
      { provide: NgxSpinnerService, useValue: { show: vi.fn(), hide: vi.fn() } },
      { provide: ThemeEngineService, useValue: { library: signal([]) } },
      {
        provide: SettingsThemesStore,
        useValue: {
          attach: vi.fn(),
          syncSelectionFromHost: vi.fn(),
          cancelPreview: vi.fn(),
          persistIfDirty: vi.fn(async () => undefined),
          afterPersist: vi.fn(),
        },
      },
    ],
  });
  return TestBed.inject(SettingsStore);
}

describe('SettingsStore LSP settings', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('lists every server under the LSP tab, Godot first', () => {
    const store = setup();
    expect(store.subTabsFor('lsp').map((tab) => tab.id)).toEqual(['gdscript', 'python', 'typescript', 'java', 'rust']);
    expect(store.activeSubTabId('lsp')).toBe('gdscript');
  });

  it('marks the draft dirty and changes only the patched field', () => {
    const store = setup();
    expect(store.settingsDirty()).toBe(false);
    store.patchGdscriptLsp({ godotBinaryPath: 'C:/godot/godot.exe' });
    expect(store.settingsDirty()).toBe(true);
    expect(store.lspServers().gdscript).toEqual({
      ...defaultLspServersSettings().gdscript,
      godotBinaryPath: 'C:/godot/godot.exe',
    });
  });

  it('shows install state in the list: bundled, installed, or missing', async () => {
    const store = setup(
      vi.fn().mockResolvedValue({
        ok: true,
        dependencies: [
          { id: 'gdls', state: 'installed', version: 'v3.1.1' },
          { id: 'java-lsp', state: 'missing', version: null },
        ],
      }),
    );
    expect(store.settingsSubTabSummary('lsp', 'gdscript')).toBe('…');
    await store.refreshLspDependencies();
    expect(store.settingsSubTabSummary('lsp', 'gdscript')).toBe('Installed · v3.1.1');
    expect(store.settingsSubTabSummary('lsp', 'java')).toBe('Not installed');
    expect(store.settingsSubTabSummary('lsp', 'python')).toBe('Bundled');
    expect(store.settingsSubTabSummary('lsp', 'typescript')).toBe('Bundled');
  });

  it('keeps the last list when a refresh fails', async () => {
    const depsList = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, dependencies: [{ id: 'gdls', state: 'installed', version: 'v3.1.1' }] })
      .mockResolvedValueOnce({ ok: false, dependencies: [], error: 'no backend' });
    const store = setup(depsList);
    await store.refreshLspDependencies();
    await store.refreshLspDependencies();
    expect(store.settingsSubTabSummary('lsp', 'gdscript')).toBe('Installed · v3.1.1');
  });
});
