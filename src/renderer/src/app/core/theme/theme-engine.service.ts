import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import type { AppConfig } from '@shared/index';
import {
  BUILTIN_THEMES,
  CLARA_DARK_THEME,
  DEFAULT_THEME_ID,
  deriveMonacoTheme,
  resolveLegacyThemeId,
  resolveThemeDocument,
  type ClaraThemeDocument,
  type ThemeMonacoDefinition,
} from '@shared/theme';
import { ElectronService } from '../electron.service';
import {
  THEME_REVISION_ATTR,
  applyResolvedThemeToDocument,
  createDomColorResolver,
  rendererThemeAssetUrl,
} from './theme-dom';

/**
 * Applies the active (or previewed) theme document to this window's `document`.
 *
 * One instance per BrowserWindow (main, settings, health, dependencies). It follows:
 * - `AppConfig.themeId` for the persisted selection,
 * - the theme library broadcast from Electron main (built-ins + user themes on disk),
 * - a draft preview broadcast while the Settings editor or an agent proposal card is active.
 *
 * Consumers that derive palettes from the CSS variables (xterm, Monaco, charts) read
 * {@link revision} / `data-theme-revision` to know when to recompute.
 */
@Injectable({ providedIn: 'root' })
export class ThemeEngineService {
  private readonly electron = inject(ElectronService);
  private readonly destroyRef = inject(DestroyRef);
  private started = false;

  /** All selectable themes: built-ins first, then user themes. */
  readonly library = signal<readonly ClaraThemeDocument[]>(BUILTIN_THEMES);
  /** Persisted selection (`AppConfig.themeId`, legacy ids already mapped). */
  readonly activeThemeId = signal<string>(DEFAULT_THEME_ID);
  /** Draft shown instead of the active theme while non-null. */
  readonly preview = signal<ClaraThemeDocument | null>(null);

  /** Document currently painted. Falls back to the dark built-in when the id is unknown. */
  readonly applied = computed<ClaraThemeDocument>(() => {
    const preview = this.preview();
    if (preview) {
      return preview;
    }
    const id = this.activeThemeId();
    return this.library().find((t) => t.id === id) ?? CLARA_DARK_THEME;
  });

  readonly resolved = computed(() => resolveThemeDocument(this.applied()));
  readonly mode = computed(() => this.applied().mode);
  readonly isPreviewing = computed(() => this.preview() !== null);

  /** Increments after every DOM apply. */
  readonly revision = signal(0);
  /** Monaco palette for the applied theme (derived after tokens hit the DOM). */
  readonly monacoTheme = signal<ThemeMonacoDefinition | null>(null);

  private readonly colorResolver = createDomColorResolver(document);

  constructor() {
    effect(() => {
      const resolved = this.resolved();
      const applied = this.applied();
      untracked(() => {
        applyResolvedThemeToDocument(document, resolved, rendererThemeAssetUrl);
        const monacoHasBackground = resolved.groups.some((g) => g.id === 'editor.monaco' && g.background !== null);
        this.monacoTheme.set(
          deriveMonacoTheme(applied, {
            baseTokens: resolved.tokens,
            resolver: this.colorResolver,
            transparentBackground: monacoHasBackground,
          }),
        );
        const next = this.revision() + 1;
        this.revision.set(next);
        document.documentElement.setAttribute(THEME_REVISION_ATTR, String(next));
      });
    });
  }

  /** Wire this window to Electron config / library / preview broadcasts. Idempotent. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    const configSub = this.electron.config$.subscribe((config) => this.applyConfig(config));
    const librarySub = this.electron.themeLibrary$.subscribe((themes) => this.setLibrary(themes));
    const previewSub = this.electron.themePreview$.subscribe((draft) => this.preview.set(draft));
    this.destroyRef.onDestroy(() => {
      configSub.unsubscribe();
      librarySub.unsubscribe();
      previewSub.unsubscribe();
    });
    void this.electron.loadConfig().then((config) => this.applyConfig(config));
    void this.electron.listThemes().then((themes) => this.setLibrary(themes));
  }

  applyConfig(config: Pick<AppConfig, 'themeId'>): void {
    this.activeThemeId.set(resolveLegacyThemeId(config.themeId));
  }

  setLibrary(themes: readonly ClaraThemeDocument[]): void {
    const userThemes = themes.filter((t) => !BUILTIN_THEMES.some((b) => b.id === t.id));
    this.library.set([...BUILTIN_THEMES, ...userThemes]);
  }

  findTheme(id: string): ClaraThemeDocument | undefined {
    return this.library().find((t) => t.id === id);
  }
}
