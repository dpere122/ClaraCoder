import type { ClaraThemeDocument, ThemeMode } from '../theme-document';
import { CLARA_DARK_THEME } from './clara-dark';
import { CLARA_DARK_CADMIUM_LANTERN_THEME } from './clara-dark-cadmium-lantern';
import { CLARA_DARK_CADMIUM_ORANGE_THEME } from './clara-dark-cadmium-orange';
import { CLARA_LIGHT_THEME } from './clara-light';
import { CLARA_LIGHT_IRIS_THEME } from './clara-light-iris';
import { CLARA_LIGHT_OCHRE_THEME } from './clara-light-ochre';

export { CLARA_DARK_THEME } from './clara-dark';
export { CLARA_DARK_CADMIUM_LANTERN_THEME } from './clara-dark-cadmium-lantern';
export { CLARA_DARK_CADMIUM_ORANGE_THEME } from './clara-dark-cadmium-orange';
export { CLARA_LIGHT_THEME } from './clara-light';
export { CLARA_LIGHT_IRIS_THEME } from './clara-light-iris';
export { CLARA_LIGHT_OCHRE_THEME } from './clara-light-ochre';

/** First-run selection and fallback when a theme id cannot be resolved. */
export const DEFAULT_THEME: ClaraThemeDocument = CLARA_DARK_THEME;

/** Bundled, read-only themes. Users duplicate these to start their own. */
export const BUILTIN_THEMES: readonly ClaraThemeDocument[] = [
  CLARA_DARK_THEME,
  CLARA_DARK_CADMIUM_LANTERN_THEME,
  CLARA_DARK_CADMIUM_ORANGE_THEME,
  CLARA_LIGHT_THEME,
  CLARA_LIGHT_IRIS_THEME,
  CLARA_LIGHT_OCHRE_THEME,
];

export const DEFAULT_THEME_ID = DEFAULT_THEME.id;

export const BUILTIN_THEME_IDS: readonly string[] = BUILTIN_THEMES.map((t) => t.id);

/** Retired theme ids (pre-engine `config.json` ids and the former `default` built-in) → built-in replacement. */
export const LEGACY_THEME_ID_MAP: Readonly<Record<string, string>> = {
  default: CLARA_DARK_THEME.id,
  woodland: CLARA_DARK_THEME.id,
  'dark-classical': CLARA_DARK_THEME.id,
  classical: CLARA_LIGHT_THEME.id,
};

export function isBuiltInThemeId(id: unknown): id is string {
  return typeof id === 'string' && BUILTIN_THEME_IDS.indexOf(id) >= 0;
}

export function findBuiltInTheme(id: string): ClaraThemeDocument | undefined {
  return BUILTIN_THEMES.find((t) => t.id === id);
}

/** Base built-in for a mode: first paint, unknown-id fallback, and tokens a partial theme omits. */
export function builtInThemeForMode(mode: ThemeMode): ClaraThemeDocument {
  return mode === 'light' ? CLARA_LIGHT_THEME : DEFAULT_THEME;
}

/** Map a legacy id to its replacement; unknown ids pass through unchanged. */
export function resolveLegacyThemeId(id: string | null | undefined): string {
  const trimmed = typeof id === 'string' ? id.trim() : '';
  if (!trimmed) {
    return DEFAULT_THEME_ID;
  }
  return LEGACY_THEME_ID_MAP[trimmed] ?? trimmed;
}
