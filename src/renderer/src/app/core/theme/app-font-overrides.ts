import type { AppConfig } from '@shared/index';
import { clampUiFontSizeRem } from '@shared/index';

/**
 * Applies Settings → General UI preferences on `documentElement` (independent of the theme):
 * - `uiFontSizeRem` scales the root `html` font size (rem-based UI chrome follows).
 * - `--t-font-ui-override` drives all app UI text (`html, body`), except Monaco and code blocks.
 * - `--t-font-code-override` drives rendered markdown code blocks and takes priority over the
 *   Monaco editor's own `fontFamily` setting (see `resolveMonacoWorkspaceFontFamily`).
 * Runs per-window (each Electron `BrowserWindow` — main, settings — has its own `document`).
 */
export function applyAppFontOverrides(
  config: Pick<AppConfig, 'uiFontFamily' | 'codeFontFamily' | 'uiFontSizeRem'>,
): void {
  const root = document.documentElement.style;
  root.fontSize = `${clampUiFontSizeRem(config.uiFontSizeRem) * 100}%`;
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
