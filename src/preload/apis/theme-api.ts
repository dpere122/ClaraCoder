import { ipcRenderer } from 'electron';
import { THEME_IPC } from '../../shared/theme/theme-ipc';
import type { ClaraThemeDocument, ThemeMode } from '../../shared/theme/theme-document';

/** Theme library (disk CRUD in main), asset picking, and cross-window live preview. */
export const themeApi = {
  listThemes: () => ipcRenderer.invoke(THEME_IPC.list),
  saveTheme: (theme: ClaraThemeDocument) => ipcRenderer.invoke(THEME_IPC.save, theme),
  createTheme: (payload: { name: string; mode: ThemeMode; fromThemeId?: string }) =>
    ipcRenderer.invoke(THEME_IPC.create, payload),
  duplicateTheme: (themeId: string, name: string) => ipcRenderer.invoke(THEME_IPC.duplicate, themeId, name),
  deleteTheme: (themeId: string) => ipcRenderer.invoke(THEME_IPC.delete, themeId),
  importThemeFile: () => ipcRenderer.invoke(THEME_IPC.import),
  exportTheme: (themeId: string) => ipcRenderer.invoke(THEME_IPC.export, themeId),
  /**
   * Copies an image into the theme folder. Removing an asset is a draft mutation in the
   * renderer; the orphaned file is pruned by the next `saveTheme` (so Cancel can revert it).
   */
  pickThemeAsset: (themeId: string) => ipcRenderer.invoke(THEME_IPC.pickAsset, themeId),
  /** Broadcast a draft to every window (or `null` to return to the persisted theme). */
  previewTheme: (theme: ClaraThemeDocument | null) => ipcRenderer.invoke(THEME_IPC.preview, theme),
  onThemeLibraryUpdated: (callback: (event: unknown, themes: unknown) => void) =>
    ipcRenderer.on(THEME_IPC.libraryUpdated, callback),
  onThemePreview: (callback: (event: unknown, theme: unknown) => void) =>
    ipcRenderer.on(THEME_IPC.previewChanged, callback),
};
