import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path = require('path');
import { getAppDataDir } from '../paths';

/**
 * Starting folder for native file dialogs.
 *
 * Since Electron 43 a dialog shown without `defaultPath` opens in Downloads every time, and the OS
 * no longer returns to the folder the user last browsed. The app remembers that folder itself, in
 * one file shared by every dialog, which is how the OS tracked it per application.
 */
let lastFolder: string | null | undefined;

function storePath(): string {
  return path.join(getAppDataDir(), 'dialog-folder.json');
}

/** Desktop on Windows/macOS when that folder exists; otherwise the user home directory. */
export function defaultOpenFileDialogPath(): string {
  const home = homedir();
  if (process.platform === 'win32' || process.platform === 'darwin') {
    const desktop = path.join(home, 'Desktop');
    if (existsSync(desktop)) {
      return desktop;
    }
  }
  return home;
}

/** Folder of the last pick in any dialog, or undefined when none is saved or it is gone. */
export function lastDialogFolder(): string | undefined {
  if (lastFolder === undefined) {
    lastFolder = null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(storePath(), 'utf8'));
      const folder = (parsed as { folder?: unknown } | null)?.folder;
      if (typeof folder === 'string' && path.isAbsolute(folder)) {
        lastFolder = folder;
      }
    } catch {
      /* nothing saved yet */
    }
  }
  return lastFolder && existsSync(lastFolder) ? lastFolder : undefined;
}

/**
 * `defaultPath` option for a dialog that has no starting folder of its own. Without a remembered
 * folder it is `fallback`, or absent so Electron uses Downloads.
 */
export function dialogFolderOption(fallback?: string): { defaultPath?: string } {
  const folder = lastDialogFolder() ?? fallback;
  return folder ? { defaultPath: folder } : {};
}

/** Record the folder that held the picked file or directory; the next dialog starts there. */
export function rememberDialogFolder(pickedPath: string): void {
  const folder = path.dirname(path.resolve(pickedPath));
  if (folder === lastFolder) {
    return;
  }
  lastFolder = folder;
  try {
    writeFileSync(storePath(), JSON.stringify({ folder }), 'utf8');
  } catch {
    /* still remembered for this session */
  }
}

/** Forget the cached folder so the next read comes from disk (tests only). */
export function resetDialogFolderForTests(): void {
  lastFolder = undefined;
}
