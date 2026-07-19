import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';

export type BrowserWindowRevealOptions = {
  /** Focus after show (default true). */
  focus?: boolean;
  /** Hard fallback delay in ms when ready-to-show never fires (default 3000). */
  fallbackDelayMs?: number;
  /** Delay after did-finish-load before revealing if still hidden (default 500). */
  loadRevealDelayMs?: number;
};

/**
 * Show a BrowserWindow when `ready-to-show` is skipped (common on Linux Wayland + disable-gpu).
 * Mirrors the main window reveal logic so satellite windows (settings, health) map reliably.
 */
export function attachBrowserWindowRevealFallbacks(
  win: BrowserWindow,
  options: BrowserWindowRevealOptions = {},
): void {
  const focus = options.focus !== false;
  const fallbackDelayMs = options.fallbackDelayMs ?? 3000;
  const loadRevealDelayMs = options.loadRevealDelayMs ?? 500;
  let revealed = false;

  const reveal = (): void => {
    if (revealed || win.isDestroyed()) return;
    revealed = true;
    try {
      if (!win.isVisible()) {
        win.show();
      }
      if (focus) {
        win.focus();
      }
    } catch (err) {
      console.error('[Main] Failed to reveal BrowserWindow:', err);
    }
  };

  win.once('ready-to-show', reveal);
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      if (!win.isDestroyed() && !win.isVisible()) {
        reveal();
      }
    }, loadRevealDelayMs);
  });
  setTimeout(reveal, fallbackDelayMs);

  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error('[Main] Renderer failed to load:', code, description, url);
    reveal();
  });
}

/**
 * Parent/modal options for the settings BrowserWindow.
 * Modal child windows are unreliable on Linux Wayland (especially with frameless parents).
 */
export function settingsWindowParentOptions(
  mainWindow: BrowserWindow,
): Pick<BrowserWindowConstructorOptions, 'parent' | 'modal'> {
  if (process.platform === 'linux') {
    return { parent: mainWindow, modal: false };
  }
  return { parent: mainWindow, modal: true };
}
