import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import type { AppConfig } from '@shared/index';
import {
  BUILTIN_THEMES,
  MONACO_THEME_GROUP_ID,
  builtInThemeForMode,
  deriveMonacoTheme,
  resolveLegacyThemeId,
  resolveThemeDocument,
  type ClaraThemeDocument,
  type ThemeMode,
  type ThemeMonacoDefinition,
} from '@shared/theme';
import { ElectronService } from '../electron.service';
import {
  THEME_REVISION_ATTR,
  applyResolvedThemeToDocument,
  browserModeStorage,
  createDomColorResolver,
  readCachedThemeMode,
  rendererThemeAssetUrl,
  writeCachedThemeMode,
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

  /**
   * Mode of the last painted theme (seeded from `localStorage`). Used as the fallback while
   * the library has not arrived yet, or when the persisted id no longer exists, so the window
   * never flips dark↔light on its way to the real theme.
   */
  readonly fallbackMode = signal<ThemeMode>(readCachedThemeMode(browserModeStorage()));

  /** All selectable themes: built-ins first, then user themes. */
  readonly library = signal<readonly ClaraThemeDocument[]>(BUILTIN_THEMES);
  /**
   * Persisted selection (`AppConfig.themeId`, legacy ids already mapped). Starts as the
   * built-in for {@link fallbackMode} so the pre-config paint matches the pre-bootstrap one.
   */
  readonly activeThemeId = signal<string>(builtInThemeForMode(this.fallbackMode()).id);
  /** Draft shown instead of the active theme while non-null. */
  readonly preview = signal<ClaraThemeDocument | null>(null);

  /** Document currently painted. Unknown ids fall back to the built-in for {@link fallbackMode}. */
  readonly applied = computed<ClaraThemeDocument>(() => {
    const preview = this.preview();
    if (preview) {
      return preview;
    }
    const id = this.activeThemeId();
    return this.library().find((t) => t.id === id) ?? builtInThemeForMode(this.fallbackMode());
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
        const monacoHasBackground = resolved.groups.some((g) => g.id === MONACO_THEME_GROUP_ID && g.background !== null);
        this.monacoTheme.set(
          deriveMonacoTheme(applied, {
            baseTokens: resolved.tokens,
            resolver: this.colorResolver,
            transparentBackground: monacoHasBackground,
          }),
        );
        // Only a real (non-preview) apply moves the fallback so a cancelled preview cannot
        // leave the next start in the wrong mode.
        if (!this.preview()) {
          this.fallbackMode.set(resolved.mode);
          writeCachedThemeMode(browserModeStorage(), resolved.mode);
        }
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
