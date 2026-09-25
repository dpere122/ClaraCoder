import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@shared/index';
import { CLARA_DARK_THEME, CLARA_LIGHT_THEME, type ClaraThemeDocument } from '@shared/theme';
import { ElectronService } from '../electron.service';
import { THEME_GROUPS_STYLE_ID, THEME_TOKENS_STYLE_ID, applyBuiltInThemeSync, createDomColorResolver } from './theme-dom';
import { ThemeEngineService } from './theme-engine.service';

const neon: ClaraThemeDocument = {
  version: 1,
  id: 'neon',
  name: 'Neon',
  mode: 'light',
  tokens: { '--t-primary': '#ff00ff' },
  groups: {
    'chat.transcript': {
      tokens: { '--t-bg': '#101010' },
      css: '.msg-bubble { border-radius: 0 }',
      background: { enabled: true, asset: 'wall', opacity: 0.5, fit: 'cover' },
    },
    'editor.monaco': {
      background: { enabled: true, asset: 'wall', opacity: 0.3, fit: 'tile' },
    },
  },
  assets: { wall: 'wall.png' },
};

function tokensCss(): string {
  return document.getElementById(THEME_TOKENS_STYLE_ID)?.textContent ?? '';
}

function groupsCss(): string {
  return document.getElementById(THEME_GROUPS_STYLE_ID)?.textContent ?? '';
}

describe('theme-dom', () => {
  it('applyBuiltInThemeSync paints the dark built-in before bootstrap', () => {
    applyBuiltInThemeSync(document);
    expect(document.documentElement.getAttribute('data-theme-id')).toBe('clara-dark');
    expect(document.documentElement.getAttribute('data-theme-mode')).toBe('dark');
    expect(document.documentElement.getAttribute('data-bs-theme')).toBe('dark');
    expect(tokensCss()).toContain(`--t-bg: ${CLARA_DARK_THEME.tokens['--t-bg']};`);
    expect(document.documentElement.classList.contains('theme-woodland')).toBe(false);
  });

  it('createDomColorResolver resolves plain colors and returns null for garbage', () => {
    const resolve = createDomColorResolver(document);
    expect(resolve('rgb(255, 0, 0)')).toBe('#ff0000');
    expect(resolve('not-a-color-at-all')).toBeNull();
  });
});

describe('ThemeEngineService', () => {
  let configSubject: Subject<AppConfig>;
  let librarySubject: Subject<ClaraThemeDocument[]>;
  let previewSubject: Subject<ClaraThemeDocument | null>;
  let listThemes: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    configSubject = new Subject<AppConfig>();
    librarySubject = new Subject<ClaraThemeDocument[]>();
    previewSubject = new Subject<ClaraThemeDocument | null>();
    listThemes = vi.fn(async () => [neon]);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: ElectronService,
          useValue: {
            config$: configSubject.asObservable(),
            themeLibrary$: librarySubject.asObservable(),
            themePreview$: previewSubject.asObservable(),
            loadConfig: vi.fn(async () => ({ themeId: 'woodland' }) as AppConfig),
            listThemes,
          },
        },
      ],
    });
  });

  it('paints the default theme on construction and stamps a revision', () => {
    const engine = TestBed.inject(ThemeEngineService);
    TestBed.tick();
    expect(engine.applied().id).toBe('clara-dark');
    expect(engine.revision()).toBeGreaterThan(0);
    expect(document.documentElement.getAttribute('data-theme-revision')).toBe(String(engine.revision()));
    expect(tokensCss()).toContain(':root {');
    expect(engine.monacoTheme()?.base).toBe('vs-dark');
  });

  it('maps legacy config ids and follows library / preview broadcasts', async () => {
    const engine = TestBed.inject(ThemeEngineService);
    engine.start();
    await Promise.resolve();
    await Promise.resolve();
    TestBed.tick();
    // `woodland` from the mocked loadConfig → clara-dark.
    expect(engine.activeThemeId()).toBe('clara-dark');
    expect(listThemes).toHaveBeenCalled();
    expect(engine.library().map((t) => t.id)).toEqual(['clara-dark', 'clara-light', 'neon']);

    configSubject.next({ themeId: 'classical' } as AppConfig);
    TestBed.tick();
    expect(engine.applied().id).toBe(CLARA_LIGHT_THEME.id);
    expect(document.documentElement.getAttribute('data-theme-mode')).toBe('light');
    expect(engine.monacoTheme()?.base).toBe('vs');

    configSubject.next({ themeId: 'neon' } as AppConfig);
    TestBed.tick();
    expect(engine.applied().id).toBe('neon');
    const css = tokensCss();
    expect(css).toContain('--t-primary: #ff00ff;');
    // Unset tokens inherit from the light built-in for this mode.
    expect(css).toContain(`--t-fg: ${CLARA_LIGHT_THEME.tokens['--t-fg']};`);
    expect(css).toContain('[data-theme-group="chat.transcript"] {\n  --t-bg: #101010;\n}');
    expect(css).toContain('background-image: url("clara-theme://asset/neon/wall.png");');
    expect(css).toContain('[data-theme-group="chat.transcript"] .chat-box {\n  background-color: transparent !important;');
    expect(groupsCss()).toContain('[data-theme-group="chat.transcript"] .msg-bubble { border-radius: 0; }');
    // Monaco surface has an overlay → editor background goes transparent.
    expect(engine.monacoTheme()?.colors['editor.background']).toBe('#00000000');

    const previewRevision = engine.revision();
    previewSubject.next({ ...CLARA_DARK_THEME, id: 'draft', name: 'Draft', builtIn: undefined });
    TestBed.tick();
    expect(engine.isPreviewing()).toBe(true);
    expect(engine.applied().id).toBe('draft');
    expect(engine.revision()).toBeGreaterThan(previewRevision);

    previewSubject.next(null);
    TestBed.tick();
    expect(engine.isPreviewing()).toBe(false);
    expect(engine.applied().id).toBe('neon');

    // Unknown persisted id falls back to the dark built-in without throwing.
    configSubject.next({ themeId: 'missing-theme' } as AppConfig);
    TestBed.tick();
    expect(engine.applied().id).toBe('clara-dark');
  });

  it('setLibrary keeps built-ins first and de-duplicates them', () => {
    const engine = TestBed.inject(ThemeEngineService);
    engine.setLibrary([neon, { ...CLARA_DARK_THEME }]);
    expect(engine.library().map((t) => t.id)).toEqual(['clara-dark', 'clara-light', 'neon']);
    expect(engine.findTheme('neon')?.name).toBe('Neon');
  });
});
