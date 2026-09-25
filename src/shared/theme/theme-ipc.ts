/** Result shapes for the theme IPC surface (`themes:*` channels). */
import type { ClaraThemeDocument, ThemeValidationIssue } from './theme-document';

export interface ThemeSaveResult {
  ok: boolean;
  theme?: ClaraThemeDocument;
  error?: string;
  errors?: ThemeValidationIssue[];
  warnings?: ThemeValidationIssue[];
}

export interface ThemeImportResult extends ThemeSaveResult {
  canceled?: boolean;
}

export interface ThemeExportResult {
  ok: boolean;
  path?: string;
  canceled?: boolean;
  error?: string;
}

export interface ThemeAssetPickResult {
  ok: boolean;
  /** Asset key to reference from `groups.<id>.background.asset`. */
  asset?: string;
  /** Stored file name (the value under `assets[asset]`). */
  fileName?: string;
  canceled?: boolean;
  error?: string;
}

export interface ThemeMutationResult {
  ok: boolean;
  error?: string;
}

/** IPC channel names (main handlers + preload). */
export const THEME_IPC = {
  list: 'themes:list',
  save: 'themes:save',
  create: 'themes:create',
  duplicate: 'themes:duplicate',
  delete: 'themes:delete',
  import: 'themes:import',
  export: 'themes:export',
  pickAsset: 'themes:pick-asset',
  removeAsset: 'themes:remove-asset',
  preview: 'themes:preview',
  /** main → renderer broadcast: full library after any mutation. */
  libraryUpdated: 'theme-library-updated',
  /** main → renderer broadcast: draft document or null to clear. */
  previewChanged: 'theme-preview',
} as const;
