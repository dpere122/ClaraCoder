import { shell, type BrowserWindow } from 'electron';
import { DEV_SERVER_URL } from '../constants';

/** Navigation targets the renderer is allowed to load in-place (not opened externally). */
function isAllowedInAppNavigation(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol === 'file:') {
      return true;
    }
    if (u.protocol === 'nemo-tts:') {
      return true;
    }
    if (DEV_SERVER_URL) {
      const dev = new URL(DEV_SERVER_URL);
      if (u.origin === dev.origin) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Block arbitrary navigation and delegate http(s) popups to the OS browser. */
export function hardenBrowserWindow(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedInAppNavigation(url)) {
      event.preventDefault();
    }
  });
}

/** Shared secure defaults for all app BrowserWindows. */
export function secureWebPreferences(preload: string): Electron.WebPreferences {
  return {
    nodeIntegration: false,
    contextIsolation: true,
    // Sandbox breaks multi-file preload + dev-server loading on Windows; contextIsolation is the primary boundary.
    sandbox: false,
    webSecurity: true,
    preload,
  };
}
