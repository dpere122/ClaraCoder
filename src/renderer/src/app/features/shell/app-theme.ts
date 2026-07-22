import type { AppConfig } from '@shared/index';
import { THEMES } from '../layout/theme-selector/theme-selector';

/** Resolve the app-wide theme id (single `AppConfig.themeId`; no per-workspace override). */
export function resolveAppThemeId(config: Pick<AppConfig, 'themeId'>): string {
  return config.themeId || 'dark';
}

export function applyAppTheme(themeId: string): void {
  const theme = THEMES.find((t) => t.id === themeId);
  document.documentElement.className = theme?.cssClass ?? '';
  document.documentElement.setAttribute('data-bs-theme', theme?.bsTheme ?? 'dark');
}

/**
 * Applies the Settings → General font overrides as CSS custom properties on `documentElement`:
 * - `--t-font-ui-override` drives all app UI text (`html, body`), except Monaco and code blocks.
 * - `--t-font-code-override` drives rendered markdown code blocks and takes priority over the
 *   Monaco editor's own `fontFamily` setting (see `resolveMonacoWorkspaceFontFamily`).
 * Runs per-window (each Electron `BrowserWindow` — main, settings — has its own `document`).
 */
export function applyAppFontOverrides(config: Pick<AppConfig, 'uiFontFamily' | 'codeFontFamily'>): void {
  const root = document.documentElement.style;
  const uiFont = config.uiFontFamily?.trim();
  if (uiFont) {
    root.setProperty('--t-font-ui-override', uiFont);
  } else {
    root.removeProperty('--t-font-ui-override');
  }
  const codeFont = config.codeFontFamily?.trim();
  if (codeFont) {
    root.setProperty('--t-font-code-override', codeFont);
  } else {
    root.removeProperty('--t-font-code-override');
  }
}
