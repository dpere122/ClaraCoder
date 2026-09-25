import { Injectable, computed, inject, signal, type WritableSignal } from '@angular/core';
import {
  BUILTIN_THEMES,
  CLARA_DARK_THEME,
  DEFAULT_THEME_ID,
  THEME_GROUPS,
  builtInThemeForMode,
  cloneThemeDocument,
  scopeThemeCss,
  themeGroupDef,
  validateThemeDocument,
  type ClaraThemeDocument,
  type ThemeGroupBackground,
  type ThemeGroupOverride,
  type ThemeMode,
  type ThemeMonacoDefinition,
  type ThemeValidationResult,
} from '@shared/theme';
import { ElectronService } from '../../../core/electron.service';
import { ThemeEngineService } from '../../../core/theme/theme-engine.service';
import { ThemedConfirmDialogService } from '../../../shared/themed-confirm-dialog/themed-confirm-dialog.service';
import { ThemedPromptDialogService } from '../../../shared/themed-prompt-dialog/themed-prompt-dialog.service';

/** What the parent {@link SettingsStore} hands us so theme edits participate in Apply / OK. */
export interface SettingsThemesHost {
  /** Persisted selection (`AppConfig.themeId`); we set it when the user picks a theme. */
  themeId: WritableSignal<string>;
  markDirty(): void;
}

const PREVIEW_DEBOUNCE_MS = 120;

/**
 * Editing state for the Settings → Themes tab.
 *
 * - Selecting a theme makes it the pending active theme (persisted with the rest of settings)
 *   and previews it in every window.
 * - Editing a user theme mutates a draft copy; every edit re-broadcasts a live preview.
 * - `persistIfDirty()` writes the draft to disk (called from the parent store's Apply / OK).
 * - Closing without saving clears the preview so windows return to the saved theme.
 */
@Injectable({ providedIn: 'root' })
export class SettingsThemesStore {
  private readonly electron = inject(ElectronService);
  private readonly engine = inject(ThemeEngineService);
  private readonly confirm = inject(ThemedConfirmDialogService);
  private readonly prompt = inject(ThemedPromptDialogService);
  private host: SettingsThemesHost | null = null;
  private previewTimer: ReturnType<typeof setTimeout> | null = null;

  readonly library = this.engine.library;
  readonly groups = THEME_GROUPS;

  /** Theme highlighted in the library list (also the pending `AppConfig.themeId`). */
  readonly selectedId = signal<string>(DEFAULT_THEME_ID);
  /** Editable copy of the selected user theme (null for built-ins). */
  readonly draft = signal<ClaraThemeDocument | null>(null);
  readonly draftDirty = signal(false);
  readonly busy = signal(false);
  readonly status = signal<string>('');

  readonly selectedTheme = computed<ClaraThemeDocument>(() => {
    const draft = this.draft();
    if (draft) {
      return draft;
    }
    const id = this.selectedId();
    return this.library().find((t) => t.id === id) ?? CLARA_DARK_THEME;
  });

  readonly isBuiltIn = computed(() => this.selectedTheme().builtIn === true || this.draft() === null);
  readonly readOnly = computed(() => this.isBuiltIn());

  /** Mode built-in tokens under the selected theme — what each token resolves to. */
  readonly effectiveTokens = computed<Record<string, string>>(() => ({
    ...builtInThemeForMode(this.selectedTheme().mode).tokens,
    ...this.selectedTheme().tokens,
  }));

  readonly validation = computed<ThemeValidationResult>(() => validateThemeDocument(this.selectedTheme()));

  readonly userThemes = computed(() => this.library().filter((t) => !t.builtIn));
  readonly builtInThemes = computed(() => this.library().filter((t) => t.builtIn));

  attach(host: SettingsThemesHost): void {
    this.host = host;
    this.selectedId.set(host.themeId());
    this.loadDraftForSelection();
  }

  /** Re-sync after the parent hydrates from config (e.g. first load or external change). */
  syncSelectionFromHost(): void {
    if (!this.host) {
      return;
    }
    const id = this.host.themeId();
    if (id !== this.selectedId()) {
      // An external change (agent "Save & apply", another window) must not discard edits.
      if (this.draftDirty()) {
        void this.persistIfDirty();
      }
      this.selectedId.set(id);
      this.loadDraftForSelection();
    } else if (!this.draft() && !this.isBuiltInId(id)) {
      this.loadDraftForSelection();
    }
  }

  private isBuiltInId(id: string): boolean {
    return BUILTIN_THEMES.some((t) => t.id === id);
  }

  private loadDraftForSelection(): void {
    const id = this.selectedId();
    const theme = this.library().find((t) => t.id === id);
    if (!theme || theme.builtIn) {
      this.draft.set(null);
    } else {
      this.draft.set(cloneThemeDocument(theme));
    }
    this.draftDirty.set(false);
  }

  /** Pick a theme: becomes the pending active theme and is previewed everywhere. */
  select(id: string): void {
    if (this.draftDirty() && id !== this.selectedId()) {
      // Keep unsaved edits: persisting happens on Apply / OK. Switching just changes selection.
      void this.persistIfDirty();
    }
    this.selectedId.set(id);
    this.loadDraftForSelection();
    this.host?.themeId.set(id);
    this.host?.markDirty();
    this.status.set('');
    this.schedulePreview(0);
  }

  // ── Draft mutations ──

  private mutateDraft(mutator: (doc: ClaraThemeDocument) => void): void {
    const current = this.draft();
    if (!current) {
      return;
    }
    const next = cloneThemeDocument(current);
    mutator(next);
    this.draft.set(next);
    this.draftDirty.set(true);
    this.host?.markDirty();
    this.schedulePreview();
  }

  setName(name: string): void {
    this.mutateDraft((d) => {
      d.name = name.trim().slice(0, 80) || d.id;
    });
  }

  setDescription(description: string): void {
    this.mutateDraft((d) => {
      const trimmed = description.trim().slice(0, 400);
      if (trimmed) {
        d.description = trimmed;
      } else {
        delete d.description;
      }
    });
  }

  setMode(mode: ThemeMode): void {
    this.mutateDraft((d) => {
      d.mode = mode;
    });
  }

  /** Global token; `null` clears the override so the built-in value shows through. */
  setToken(name: string, value: string | null): void {
    this.mutateDraft((d) => {
      if (value === null || !value.trim()) {
        delete d.tokens[name];
      } else {
        d.tokens[name] = value.trim();
      }
    });
  }

  private groupOverride(doc: ClaraThemeDocument, groupId: string): ThemeGroupOverride {
    if (!doc.groups[groupId]) {
      doc.groups[groupId] = {};
    }
    return doc.groups[groupId]!;
  }

  private pruneGroup(doc: ClaraThemeDocument, groupId: string): void {
    const g = doc.groups[groupId];
    if (!g) {
      return;
    }
    if (g.tokens && Object.keys(g.tokens).length === 0) {
      delete g.tokens;
    }
    if (g.css !== undefined && !g.css.trim()) {
      delete g.css;
    }
    if (!g.tokens && !g.css && !g.background) {
      delete doc.groups[groupId];
    }
  }

  setGroupToken(groupId: string, name: string, value: string | null): void {
    this.mutateDraft((d) => {
      const g = this.groupOverride(d, groupId);
      g.tokens = { ...(g.tokens ?? {}) };
      if (value === null || !value.trim()) {
        delete g.tokens[name];
      } else {
        g.tokens[name] = value.trim();
      }
      this.pruneGroup(d, groupId);
    });
  }

  setGroupCss(groupId: string, css: string): void {
    this.mutateDraft((d) => {
      const g = this.groupOverride(d, groupId);
      if (css.trim()) {
        g.css = css;
      } else {
        delete g.css;
      }
      this.pruneGroup(d, groupId);
    });
  }

  /** Sanitizer warnings for a group's advanced CSS (what would be dropped at apply time). */
  groupCssWarnings(groupId: string, css: string): string[] {
    const def = themeGroupDef(groupId);
    if (!def || !css.trim()) {
      return [];
    }
    return scopeThemeCss(css, def.selector).warnings;
  }

  setGroupBackground(groupId: string, patch: Partial<ThemeGroupBackground>): void {
    this.mutateDraft((d) => {
      const g = this.groupOverride(d, groupId);
      const current: ThemeGroupBackground = g.background ?? { enabled: false, asset: '', opacity: 0.35, fit: 'cover' };
      g.background = { ...current, ...patch };
      if (typeof g.background.opacity === 'number') {
        g.background.opacity = Math.min(1, Math.max(0, +g.background.opacity.toFixed(3)));
      }
      this.pruneGroup(d, groupId);
    });
  }

  clearGroupBackground(groupId: string): void {
    this.mutateDraft((d) => {
      const g = d.groups[groupId];
      if (g) {
        delete g.background;
        this.pruneGroup(d, groupId);
      }
    });
  }

  /** Open a file picker, copy the image into the theme folder, and point the group at it. */
  async pickGroupBackground(groupId: string): Promise<void> {
    const draft = this.draft();
    if (!draft) {
      return;
    }
    this.busy.set(true);
    try {
      const picked = await this.electron.pickThemeAsset(draft.id);
      if (!picked.ok || !picked.asset || !picked.fileName) {
        if (!picked.canceled) {
          this.status.set(picked.error ?? 'Could not add the image.');
        }
        return;
      }
      const fileName = picked.fileName;
      const stem = picked.asset;
      this.mutateDraft((d) => {
        // Main de-duplicates file names, not asset keys: `bg.png` and `bg.jpg` both stem to
        // `bg`. Pick a key that does not silently repoint other groups at the new file.
        let asset = stem;
        for (let n = 2; d.assets?.[asset] !== undefined && d.assets[asset] !== fileName; n++) {
          asset = `${stem}-${n}`;
        }
        d.assets = { ...(d.assets ?? {}), [asset]: fileName };
        const g = this.groupOverride(d, groupId);
        const current: ThemeGroupBackground = g.background ?? { enabled: true, asset, opacity: 0.35, fit: 'cover' };
        g.background = { ...current, enabled: true, asset };
      });
      this.status.set(`Added ${fileName}.`);
    } finally {
      this.busy.set(false);
    }
  }

  /** Remove an asset from the theme; groups referencing it lose their background. */
  removeAsset(asset: string): void {
    this.mutateDraft((d) => {
      if (d.assets) {
        delete d.assets[asset];
        if (Object.keys(d.assets).length === 0) {
          delete d.assets;
        }
      }
      for (const groupId of Object.keys(d.groups)) {
        const g = d.groups[groupId]!;
        if (g.background?.asset === asset) {
          delete g.background;
          this.pruneGroup(d, groupId);
        }
      }
    });
  }

  setMonaco(def: ThemeMonacoDefinition | null): void {
    this.mutateDraft((d) => {
      if (def) {
        d.monaco = def;
      } else {
        delete d.monaco;
      }
    });
  }

  /** Replace the draft with parsed JSON (Advanced pane). Returns validation issues. */
  applyJson(json: string): ThemeValidationResult | { ok: false; error: string } {
    const draft = this.draft();
    if (!draft) {
      return { ok: false, error: 'Built-in themes are read-only. Duplicate one to edit.' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { ok: false, error: 'Not valid JSON.' };
    }
    const result = validateThemeDocument(parsed);
    if (!result.ok || !result.doc) {
      return result;
    }
    const next = result.doc;
    // Id is fixed by the folder on disk; keep the draft's id.
    next.id = draft.id;
    this.draft.set(next);
    this.draftDirty.set(true);
    this.host?.markDirty();
    this.schedulePreview();
    return result;
  }

  // ── Library operations (write through to main immediately) ──

  async createTheme(): Promise<void> {
    const base = this.selectedTheme();
    const name = await this.prompt.open({
      title: 'New theme',
      message: `Start from "${base.name}". Name the new theme:`,
      placeholder: 'My theme',
      value: `${base.name} copy`,
      confirmText: 'Create',
    });
    if (!name || !name.trim()) {
      return;
    }
    await this.runLibraryOp(async () => {
      const result = await this.electron.createTheme({ name: name.trim(), mode: base.mode, fromThemeId: base.id });
      if (result.ok && result.theme) {
        this.engine.setLibrary([...this.library().filter((t) => t.id !== result.theme!.id), result.theme]);
        this.select(result.theme.id);
        this.status.set(`Created "${result.theme.name}".`);
      } else {
        this.status.set(result.error ?? 'Could not create the theme.');
      }
    });
  }

  async duplicateSelected(): Promise<void> {
    const base = this.selectedTheme();
    const name = await this.prompt.open({
      title: 'Duplicate theme',
      message: 'Name for the copy:',
      placeholder: `${base.name} copy`,
      value: `${base.name} copy`,
      confirmText: 'Duplicate',
    });
    if (!name || !name.trim()) {
      return;
    }
    await this.persistIfDirty();
    await this.runLibraryOp(async () => {
      const result = await this.electron.duplicateTheme(base.id, name.trim());
      if (result.ok && result.theme) {
        this.engine.setLibrary([...this.library().filter((t) => t.id !== result.theme!.id), result.theme]);
        this.select(result.theme.id);
        this.status.set(`Duplicated as "${result.theme.name}".`);
      } else {
        this.status.set(result.error ?? 'Could not duplicate the theme.');
      }
    });
  }

  async deleteSelected(): Promise<void> {
    const theme = this.selectedTheme();
    if (theme.builtIn) {
      return;
    }
    const choice = await this.confirm.open({
      title: 'Delete theme',
      message: `Delete "${theme.name}"? This removes its files and cannot be undone.`,
      confirmText: 'Delete',
      cancelText: 'Keep',
    });
    if (choice !== 'confirm') {
      return;
    }
    await this.runLibraryOp(async () => {
      const result = await this.electron.deleteTheme(theme.id);
      if (result.ok) {
        this.engine.setLibrary(this.library().filter((t) => t.id !== theme.id));
        this.draftDirty.set(false);
        this.select(DEFAULT_THEME_ID);
        this.status.set(`Deleted "${theme.name}".`);
      } else {
        this.status.set(result.error ?? 'Could not delete the theme.');
      }
    });
  }

  async importTheme(): Promise<void> {
    await this.runLibraryOp(async () => {
      const result = await this.electron.importThemeFile();
      if (result.canceled) {
        return;
      }
      if (result.ok && result.theme) {
        this.engine.setLibrary([...this.library().filter((t) => t.id !== result.theme!.id), result.theme]);
        this.select(result.theme.id);
        const warn = result.warnings?.length ? ` (${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'})` : '';
        this.status.set(`Imported "${result.theme.name}"${warn}.`);
      } else {
        const detail = result.errors?.map((e) => `${e.path}: ${e.message}`).join('; ');
        this.status.set(result.error ? `${result.error}${detail ? ` — ${detail}` : ''}` : 'Import failed.');
      }
    });
  }

  async exportSelected(): Promise<void> {
    await this.persistIfDirty();
    const theme = this.selectedTheme();
    await this.runLibraryOp(async () => {
      const result = await this.electron.exportTheme(theme.id);
      if (result.canceled) {
        return;
      }
      this.status.set(result.ok ? `Exported to ${result.path}.` : result.error ?? 'Export failed.');
    });
  }

  private async runLibraryOp(op: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    try {
      await op();
    } catch (err) {
      this.status.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }

  // ── Persistence + preview ──

  /** Write the draft to disk when it changed. Safe to call repeatedly. */
  async persistIfDirty(): Promise<boolean> {
    const draft = this.draft();
    if (!draft || !this.draftDirty()) {
      return true;
    }
    // Clear the flag up front so a concurrent call does not save the same document twice.
    this.draftDirty.set(false);
    const result = await this.electron.saveTheme(draft);
    // The user may have switched themes while the save was in flight (`select()` persists
    // fire-and-forget). Only touch the draft when it is still the document we saved.
    const stillEditingSaved = this.draft()?.id === draft.id;
    if (!result.ok || !result.theme) {
      const detail = result.errors?.map((e) => `${e.path}: ${e.message}`).join('; ');
      this.status.set(result.error ? `${result.error}${detail ? ` — ${detail}` : ''}` : 'Could not save the theme.');
      if (stillEditingSaved) {
        this.draftDirty.set(true);
      }
      return false;
    }
    this.engine.setLibrary([...this.library().filter((t) => t.id !== result.theme!.id), result.theme]);
    if (stillEditingSaved && !this.draftDirty()) {
      // Keep the normalized on-disk form (asset data URLs become file names, etc.) unless
      // the user kept editing while we were saving; those edits win and stay dirty.
      this.draft.set(cloneThemeDocument(result.theme));
    }
    return true;
  }

  private schedulePreview(delay: number = PREVIEW_DEBOUNCE_MS): void {
    if (this.previewTimer !== null) {
      clearTimeout(this.previewTimer);
    }
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null;
      void this.electron.previewTheme(this.selectedTheme());
    }, delay);
  }

  /** Stop previewing so every window returns to the persisted theme. */
  cancelPreview(): void {
    if (this.previewTimer !== null) {
      clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
    void this.electron.previewTheme(null);
  }

  /** Reset preview + selection after the parent persisted `themeId`. */
  afterPersist(): void {
    this.cancelPreview();
  }
}
