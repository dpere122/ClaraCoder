import type { AppConfig } from '@shared/index';
import { clampUiFontSizeRem } from '@shared/index';

/** `@font-face` in styles.css that supplies only the curly quotes. */
const NARROW_QUOTES_FONT = '"Clara Narrow Quotes"';

/**
 * Some fonts (Microsoft Tai Le) draw curly quotes a full em wide, so `I’ll` reads as `I’ ll`.
 * The 0.8em cut-off leaves monospace fonts alone: their quotes are wide by design, around 0.6em.
 */
function hasFullWidthQuotes(fontFamily: string): boolean {
  if (typeof OffscreenCanvas === 'undefined') {
    return false;
  }
  const ctx = new OffscreenCanvas(1, 1).getContext('2d');
  if (!ctx) {
    return false;
  }
  ctx.font = `100px ${fontFamily}`;
  return ctx.measureText('’').width > 80;
}

/**
 * Applies Settings → General UI preferences on `documentElement` (independent of the theme):
 * - `uiFontSizeRem` scales the root `html` font size (rem-based UI chrome follows).
 * - `--t-font-ui-override` drives all app UI text (`html, body`), except Monaco and code blocks.
 *   A font with full-width curly quotes takes those four characters from `NARROW_QUOTES_FONT`.
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
    root.setProperty(
      '--t-font-ui-override',
      hasFullWidthQuotes(uiFont) ? `${NARROW_QUOTES_FONT}, ${uiFont}` : uiFont,
    );
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
