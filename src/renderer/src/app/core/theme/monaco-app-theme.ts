import type * as Monaco from 'monaco-editor';
import { MONACO_APP_THEME_NAME, type ThemeMonacoDefinition } from '@shared/theme';
import type { MonacoWorkspaceEditorThemeId } from '@shared/index';

/**
 * Last definition registered per Monaco API instance. Every mounted editor component reacts
 * to the same `ThemeEngineService.monacoTheme()` object, so this keeps `defineTheme` (which
 * re-renders every editor on the page) to once per theme change instead of once per editor.
 */
const definedThemes = new WeakMap<typeof Monaco, ThemeMonacoDefinition>();

/** Registers (or refreshes) the app-derived Monaco theme. Safe and cheap to call repeatedly. */
export function defineMonacoAppTheme(monacoApi: typeof Monaco, def: ThemeMonacoDefinition): void {
  if (definedThemes.get(monacoApi) === def) {
    return;
  }
  monacoApi.editor.defineTheme(MONACO_APP_THEME_NAME, {
    base: def.base,
    inherit: true,
    colors: def.colors,
    rules: def.rules.map((r) => ({
      token: r.token,
      foreground: r.foreground,
      background: r.background,
      fontStyle: r.fontStyle,
    })),
  });
  definedThemes.set(monacoApi, def);
}

/**
 * Monaco theme name for the persisted Editor setting. `follow-app` maps to the app-derived
 * theme once it has been defined; before that it falls back to the light/dark stock theme.
 */
export function resolveMonacoThemeName(
  setting: MonacoWorkspaceEditorThemeId,
  appThemeDefined: boolean,
  mode: 'dark' | 'light',
): string {
  if (setting !== 'follow-app') {
    return setting;
  }
  if (appThemeDefined) {
    return MONACO_APP_THEME_NAME;
  }
  return mode === 'light' ? 'vs' : 'vs-dark';
}
