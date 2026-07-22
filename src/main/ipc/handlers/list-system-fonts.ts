import { ipcMain } from 'electron';
import { getFonts2 } from 'font-list';
import type { SystemFontInfo } from '../../../shared';

/**
 * OS-installed fonts rarely change while the app is running; cache for the process lifetime so
 * repeated Settings window opens don't re-shell out to `fc-list` / PowerShell / CoreText.
 */
let cachedFonts: SystemFontInfo[] | null = null;

async function listSystemFonts(): Promise<SystemFontInfo[]> {
  if (cachedFonts) {
    return cachedFonts;
  }
  try {
    const fonts = await getFonts2();
    cachedFonts = fonts
      .filter((f) => typeof f.familyName === 'string' && f.familyName.trim().length > 0)
      .map((f) => ({ name: f.name, familyName: f.familyName, monospace: f.monospace }));
  } catch (err) {
    console.error('[Main] Failed to list system fonts:', err);
    cachedFonts = [];
  }
  return cachedFonts;
}

/** Enumerates OS-installed font families for the Settings → General font pickers. */
export function registerListSystemFontsIpc(): void {
  ipcMain.handle('list-system-fonts', async () => listSystemFonts());
}
