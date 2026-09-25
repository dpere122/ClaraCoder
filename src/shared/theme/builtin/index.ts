import type { ClaraThemeDocument, ThemeMode } from '../theme-document';
import { CLARA_DARK_THEME } from './clara-dark';
import { CLARA_LIGHT_THEME } from './clara-light';

export { CLARA_DARK_THEME } from './clara-dark';
export { CLARA_LIGHT_THEME } from './clara-light';

/** Bundled, read-only themes. Users duplicate these to start their own. */
export const BUILTIN_THEMES: readonly ClaraThemeDocument[] = [CLARA_DARK_THEME, CLARA_LIGHT_THEME];

export const DEFAULT_THEME_ID = CLARA_DARK_THEME.id;

export const BUILTIN_THEME_IDS: readonly string[] = BUILTIN_THEMES.map((t) => t.id);

/** Pre-engine theme ids (`config.json` before schema 8) → built-in replacement. */
export const LEGACY_THEME_ID_MAP: Readonly<Record<string, string>> = {
  woodland: CLARA_DARK_THEME.id,
  'dark-classical': CLARA_DARK_THEME.id,
  classical: CLARA_LIGHT_THEME.id,
  default: CLARA_DARK_THEME.id,
};

export function isBuiltInThemeId(id: unknown): id is string {
  return typeof id === 'string' && BUILTIN_THEME_IDS.indexOf(id) >= 0;
}

export function findBuiltInTheme(id: string): ClaraThemeDocument | undefined {
  return BUILTIN_THEMES.find((t) => t.id === id);
}

export function builtInThemeForMode(mode: ThemeMode): ClaraThemeDocument {
  return mode === 'light' ? CLARA_LIGHT_THEME : CLARA_DARK_THEME;
}

/** Map a legacy id to its replacement; unknown ids pass through unchanged. */
export function resolveLegacyThemeId(id: string | null | undefined): string {
  const trimmed = typeof id === 'string' ? id.trim() : '';
  if (!trimmed) {
    return DEFAULT_THEME_ID;
  }
  return LEGACY_THEME_ID_MAP[trimmed] ?? trimmed;
}
