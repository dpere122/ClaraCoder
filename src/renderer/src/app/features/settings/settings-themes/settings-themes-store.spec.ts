import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLARA_DARK_THEME, type ClaraThemeDocument } from '@shared/theme';
import { ElectronService } from '../../../core/electron.service';
import { ThemeEngineService } from '../../../core/theme/theme-engine.service';
import { ThemedPromptDialogService } from '../../../shared/themed-prompt-dialog/themed-prompt-dialog.service';
import { SettingsThemesStore } from './settings-themes-store';

const neon: ClaraThemeDocument = {
  version: 1,
  id: 'neon',
  name: 'Neon',
  mode: 'dark',
  tokens: { '--t-primary': '#ff00ff' },
  groups: {},
  assets: {},
};

describe('SettingsThemesStore', () => {
  let electron: {
    config$: Subject<unknown>;
    themeLibrary$: Subject<ClaraThemeDocument[]>;
    themePreview$: Subject<ClaraThemeDocument | null>;
    previewTheme: ReturnType<typeof vi.fn>;
    saveTheme: ReturnType<typeof vi.fn>;
    createTheme: ReturnType<typeof vi.fn>;
    pickThemeAsset: ReturnType<typeof vi.fn>;
    loadConfig: ReturnType<typeof vi.fn>;
    listThemes: ReturnType<typeof vi.fn>;
  };
  let store: SettingsThemesStore;
  let engine: ThemeEngineService;
  let themeId: ReturnType<typeof signal<string>>;
  let markDirty: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    electron = {
      config$: new Subject(),
      themeLibrary$: new Subject(),
      themePreview$: new Subject(),
      previewTheme: vi.fn(async () => undefined),
      saveTheme: vi.fn(async (doc: ClaraThemeDocument) => ({ ok: true, theme: { ...doc, assets: { wall: 'wall.png' } } })),
      createTheme: vi.fn(async (p: { name: string }) => ({ ok: true, theme: { ...neon, id: 'neon-2', name: p.name } })),
      pickThemeAsset: vi.fn(async () => ({ ok: true, asset: 'wall', fileName: 'wall.png' })),
      loadConfig: vi.fn(async () => ({ themeId: 'clara-dark' })),
      listThemes: vi.fn(async () => [neon]),
    };
    TestBed.configureTestingModule({
      providers: [{ provide: ElectronService, useValue: electron }],
    });
    engine = TestBed.inject(ThemeEngineService);
    engine.setLibrary([neon]);
    store = TestBed.inject(SettingsThemesStore);
    themeId = signal('clara-dark');
    markDirty = vi.fn<() => void>();
    store.attach({ themeId, markDirty });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('built-ins are read-only; selecting a user theme loads an editable draft', () => {
    expect(store.readOnly()).toBe(true);
    expect(store.draft()).toBeNull();
    store.select('neon');
    expect(themeId()).toBe('neon');
    expect(markDirty).toHaveBeenCalled();
    expect(store.readOnly()).toBe(false);
    expect(store.draft()?.id).toBe('neon');
    // Selecting previews immediately (debounce 0) in every window.
    vi.runAllTimers();
    expect(electron.previewTheme).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'neon' }));
  });

  it('edits mutate a copy, mark dirty, and debounce a live preview', () => {
    store.select('neon');
    vi.runAllTimers();
    electron.previewTheme.mockClear();

    store.setToken('--t-bg', '#000000');
    store.setGroupToken('chat.transcript', '--t-primary', '#123456');
    store.setGroupCss('chat.transcript', '.msg-bubble { color: red }');
    store.setGroupBackground('editor.monaco', { opacity: 0.6 });
    expect(store.draftDirty()).toBe(true);
    expect(store.draft()?.tokens['--t-bg']).toBe('#000000');
    expect(store.draft()?.groups['chat.transcript']).toEqual({
      tokens: { '--t-primary': '#123456' },
      css: '.msg-bubble { color: red }',
    });
    expect(store.draft()?.groups['editor.monaco']?.background).toEqual({ enabled: false, asset: '', opacity: 0.6, fit: 'cover' });
    // Library copy is untouched until save.
    expect(engine.findTheme('neon')?.tokens['--t-bg']).toBeUndefined();
    expect(electron.previewTheme).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(electron.previewTheme).toHaveBeenCalledTimes(1);
    expect(electron.previewTheme.mock.calls[0]![0]).toEqual(expect.objectContaining({ tokens: expect.objectContaining({ '--t-bg': '#000000' }) }));

    // Clearing an override removes it and prunes the empty group entry.
    store.setToken('--t-bg', null);
    store.setGroupToken('chat.transcript', '--t-primary', null);
    store.setGroupCss('chat.transcript', '');
    expect(store.draft()?.tokens['--t-bg']).toBeUndefined();
    expect(store.draft()?.groups['chat.transcript']).toBeUndefined();
  });

  it('picking a background asset registers it and enables the overlay', async () => {
    store.select('neon');
    await store.pickGroupBackground('chat.transcript');
    expect(electron.pickThemeAsset).toHaveBeenCalledWith('neon');
    expect(store.draft()?.assets).toEqual({ wall: 'wall.png' });
    expect(store.draft()?.groups['chat.transcript']?.background).toEqual({ enabled: true, asset: 'wall', opacity: 0.35, fit: 'cover' });
    store.removeAsset('wall');
    expect(store.draft()?.assets).toBeUndefined();
    expect(store.draft()?.groups['chat.transcript']).toBeUndefined();
  });

  it('persistIfDirty saves the draft, adopts the normalized result, and updates the library', async () => {
    store.select('neon');
    store.setToken('--t-bg', '#000000');
    expect(await store.persistIfDirty()).toBe(true);
    expect(electron.saveTheme).toHaveBeenCalledTimes(1);
    expect(store.draftDirty()).toBe(false);
    expect(store.draft()?.assets).toEqual({ wall: 'wall.png' });
    expect(engine.findTheme('neon')?.tokens['--t-bg']).toBe('#000000');
    // No-op when clean.
    expect(await store.persistIfDirty()).toBe(true);
    expect(electron.saveTheme).toHaveBeenCalledTimes(1);
  });

  it('applyJson replaces the draft but keeps the id; cancelPreview clears the broadcast', () => {
    store.select('neon');
    const result = store.applyJson(JSON.stringify({ ...CLARA_DARK_THEME, id: 'something-else', name: 'Imported' }));
    expect(result.ok).toBe(true);
    expect(store.draft()?.id).toBe('neon');
    expect(store.draft()?.name).toBe('Imported');
    expect(store.applyJson('{ nope').ok).toBe(false);
    store.cancelPreview();
    expect(electron.previewTheme).toHaveBeenLastCalledWith(null);
  });

  it('createTheme prompts for a name, writes through main, and selects the result', async () => {
    const prompt = TestBed.inject(ThemedPromptDialogService);
    const pending = store.createTheme();
    // Resolve the themed prompt as the user would.
    expect(prompt.active()).not.toBeNull();
    prompt.close('Neon Two');
    await pending;
    expect(electron.createTheme).toHaveBeenCalledWith({ name: 'Neon Two', mode: 'dark', fromThemeId: 'clara-dark' });
    expect(store.selectedId()).toBe('neon-2');
    expect(themeId()).toBe('neon-2');
    expect(engine.findTheme('neon-2')?.name).toBe('Neon Two');
  });
});
