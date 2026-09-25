import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { promises as fs } from 'fs';
import { mainState } from '../../state';
import { updateConfig } from '../../config/load-save';
import { assertTrustedAppRenderer } from '../assert-trusted-renderer';
import { DEFAULT_THEME_ID, isBuiltInThemeId } from '../../../shared/theme/builtin';
import { validateThemeDocument, type ClaraThemeDocument, type ThemeMode } from '../../../shared/theme/theme-document';
import { THEME_IPC } from '../../../shared/theme/theme-ipc';
import type { ThemeAssetPickResult, ThemeExportResult, ThemeImportResult, ThemeMutationResult, ThemeSaveResult } from '../../../shared/theme/theme-ipc';
import {
  THEME_ASSET_MIME_BY_EXT,
  THEME_BUNDLE_EXTENSION,
  addThemeAssetFromFile,
  createUserTheme,
  deleteUserTheme,
  duplicateTheme,
  exportThemeBundle,
  importThemeBundle,
  listAllThemes,
  removeThemeAssetFile,
  writeUserTheme,
} from '../../theme/theme-store';

function allAppWindows(): BrowserWindow[] {
  return [mainState.mainWindow, mainState.settingsWindow, mainState.healthWindow, mainState.dependenciesWindow].filter(
    (w): w is BrowserWindow => !!w && !w.isDestroyed(),
  );
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of allAppWindows()) {
    try {
      win.webContents.send(channel, payload);
    } catch {
      // Window can be torn down between the check and send.
    }
  }
}

/** Push the full library to every window (after any mutation). */
export async function broadcastThemeLibrary(): Promise<ClaraThemeDocument[]> {
  const themes = await listAllThemes();
  broadcast(THEME_IPC.libraryUpdated, themes);
  return themes;
}

/** Paint `theme` in every window without persisting; `null` returns to the saved theme. */
export function broadcastThemePreview(theme: ClaraThemeDocument | null): void {
  broadcast(THEME_IPC.previewChanged, theme);
}

function senderWindow(event: IpcMainInvokeEvent): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(event.sender) ?? mainState.mainWindow ?? undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Theme library CRUD, import/export, asset picking, and live preview. */
export function registerThemesIpc(): void {
  ipcMain.handle(THEME_IPC.list, async (event): Promise<ClaraThemeDocument[]> => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return [];
    }
    return listAllThemes();
  });

  ipcMain.handle(THEME_IPC.save, async (event, raw: unknown): Promise<ThemeSaveResult> => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return { ok: false, error: 'Untrusted IPC sender' };
    }
    const validated = validateThemeDocument(raw);
    if (!validated.ok || !validated.doc) {
      return { ok: false, error: 'Theme document is invalid', errors: validated.errors, warnings: validated.warnings };
    }
    try {
      const result = await writeUserTheme(validated.doc);
      if (result.ok) {
        await broadcastThemeLibrary();
      }
      return result;
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle(
    THEME_IPC.create,
    async (event, payload: { name?: unknown; mode?: unknown; fromThemeId?: unknown }): Promise<ThemeSaveResult> => {
      try {
        assertTrustedAppRenderer(event);
      } catch {
        return { ok: false, error: 'Untrusted IPC sender' };
      }
      const name = typeof payload?.name === 'string' ? payload.name : '';
      const mode: ThemeMode = payload?.mode === 'light' ? 'light' : 'dark';
      const fromThemeId = typeof payload?.fromThemeId === 'string' && payload.fromThemeId.trim() ? payload.fromThemeId.trim() : undefined;
      try {
        const result = await createUserTheme({ name, mode, fromThemeId });
        if (result.ok) {
          await broadcastThemeLibrary();
        }
        return result;
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    },
  );

  ipcMain.handle(THEME_IPC.duplicate, async (event, themeId: unknown, name: unknown): Promise<ThemeSaveResult> => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return { ok: false, error: 'Untrusted IPC sender' };
    }
    if (typeof themeId !== 'string') {
      return { ok: false, error: 'Invalid theme id' };
    }
    try {
      const result = await duplicateTheme(themeId, typeof name === 'string' ? name : '');
      if (result.ok) {
        await broadcastThemeLibrary();
      }
      return result;
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle(THEME_IPC.delete, async (event, themeId: unknown): Promise<ThemeMutationResult> => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return { ok: false, error: 'Untrusted IPC sender' };
    }
    if (typeof themeId !== 'string' || isBuiltInThemeId(themeId)) {
      return { ok: false, error: 'Built-in themes cannot be deleted' };
    }
    try {
      const result = await deleteUserTheme(themeId);
      if (result.ok) {
        // If the deleted theme was active, fall back to the default so every window agrees.
        const config = await updateConfig((cfg) => {
          if (cfg.themeId === themeId) {
            cfg.themeId = DEFAULT_THEME_ID;
          }
        });
        broadcast('config-updated', config);
        await broadcastThemeLibrary();
      }
      return result;
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle(THEME_IPC.import, async (event): Promise<ThemeImportResult> => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return { ok: false, error: 'Untrusted IPC sender' };
    }
    const parent = senderWindow(event);
    const picked = parent
      ? await dialog.showOpenDialog(parent, {
          title: 'Import theme',
          properties: ['openFile'],
          filters: [
            { name: 'Clara theme', extensions: ['json'] },
            { name: 'All files', extensions: ['*'] },
          ],
        })
      : await dialog.showOpenDialog({ title: 'Import theme', properties: ['openFile'] });
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    try {
      const json = await fs.readFile(picked.filePaths[0]!, 'utf8');
      const result = await importThemeBundle(json);
      if (result.ok) {
        await broadcastThemeLibrary();
      }
      return result;
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle(THEME_IPC.export, async (event, themeId: unknown): Promise<ThemeExportResult> => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return { ok: false, error: 'Untrusted IPC sender' };
    }
    if (typeof themeId !== 'string') {
      return { ok: false, error: 'Invalid theme id' };
    }
    try {
      const bundle = await exportThemeBundle(themeId);
      if (!bundle) {
        return { ok: false, error: `Theme "${themeId}" not found` };
      }
      const parent = senderWindow(event);
      const options = {
        title: 'Export theme',
        defaultPath: bundle.fileName,
        filters: [{ name: 'Clara theme', extensions: ['json'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation'] as Array<'createDirectory' | 'showOverwriteConfirmation'>,
      };
      const picked = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
      if (picked.canceled || !picked.filePath) {
        return { ok: false, canceled: true };
      }
      let target = picked.filePath;
      if (!/\.json$/i.test(target)) {
        target = `${target}${THEME_BUNDLE_EXTENSION}`;
      }
      await fs.writeFile(target, bundle.json, 'utf8');
      return { ok: true, path: target };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle(THEME_IPC.pickAsset, async (event, themeId: unknown): Promise<ThemeAssetPickResult> => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return { ok: false, error: 'Untrusted IPC sender' };
    }
    if (typeof themeId !== 'string') {
      return { ok: false, error: 'Invalid theme id' };
    }
    const parent = senderWindow(event);
    const options = {
      title: 'Choose a background image',
      properties: ['openFile'] as Array<'openFile'>,
      filters: [{ name: 'Images', extensions: Object.keys(THEME_ASSET_MIME_BY_EXT) }],
    };
    const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    try {
      return await addThemeAssetFromFile(themeId, picked.filePaths[0]!);
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle(THEME_IPC.removeAsset, async (event, themeId: unknown, fileName: unknown): Promise<ThemeMutationResult> => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return { ok: false, error: 'Untrusted IPC sender' };
    }
    if (typeof themeId !== 'string' || typeof fileName !== 'string') {
      return { ok: false, error: 'Invalid asset reference' };
    }
    return removeThemeAssetFile(themeId, fileName);
  });

  ipcMain.handle(THEME_IPC.preview, async (event, raw: unknown): Promise<void> => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return;
    }
    if (raw === null || raw === undefined) {
      broadcastThemePreview(null);
      return;
    }
    const validated = validateThemeDocument(raw);
    if (validated.ok && validated.doc) {
      broadcastThemePreview(validated.doc);
    }
  });
}
