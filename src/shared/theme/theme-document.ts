/**
 * The Clara theme document: a JSON-serializable description of an app theme.
 *
 * - `tokens` — global `--t-*` values (see `theme-tokens.ts`). Partial documents are fine;
 *   the engine layers them over the built-in theme for the same `mode`.
 * - `groups` — per registered element group (see `theme-registry.generated.ts`): scoped
 *   token overrides, optional advanced CSS, and an optional background image overlay.
 * - `monaco` — optional Monaco palette; when absent one is derived from the tokens.
 * - `assets` — logical asset name → on-disk file name (theme folder) or `data:` URL (portable
 *   export bundle).
 *
 * `validateThemeDocument()` never throws and is used by Electron main (import / save), the
 * renderer (editor + agent proposals), and tests.
 */

import { THEME_GROUP_IDS } from './theme-registry.generated';
import { THEME_GROUP_CSS_MAX_CHARS, scopeThemeCss } from './theme-css-scope';
import { THEME_TOKENS, isThemeTokenName, themeTokenDef } from './theme-tokens';

export const THEME_DOCUMENT_VERSION = 1 as const;

export type ThemeMode = 'dark' | 'light';
export const THEME_MODES: readonly ThemeMode[] = ['dark', 'light'];

export type ThemeBackgroundFit = 'cover' | 'contain' | 'tile' | 'center';
export const THEME_BACKGROUND_FITS: readonly ThemeBackgroundFit[] = ['cover', 'contain', 'tile', 'center'];

export type ThemeMonacoBase = 'vs' | 'vs-dark' | 'hc-black' | 'hc-light';
export const THEME_MONACO_BASES: readonly ThemeMonacoBase[] = ['vs', 'vs-dark', 'hc-black', 'hc-light'];

export interface ThemeGroupBackground {
  enabled: boolean;
  /** Key into {@link ClaraThemeDocument.assets}. */
  asset: string;
  /** Overlay opacity, 0–1. */
  opacity: number;
  fit: ThemeBackgroundFit;
}

export interface ThemeGroupOverride {
  /** `--t-*` values that apply only inside this group. */
  tokens?: Record<string, string>;
  /** Advanced CSS; sanitized and scoped to the group root at apply time. */
  css?: string;
  background?: ThemeGroupBackground;
}

export interface ThemeMonacoRule {
  token: string;
  /** Hex without `#`. */
  foreground?: string;
  /** Hex without `#`. */
  background?: string;
  fontStyle?: string;
}

export interface ThemeMonacoDefinition {
  base: ThemeMonacoBase;
  /** Monaco color id → `#rrggbb[aa]`. */
  colors: Record<string, string>;
  rules: ThemeMonacoRule[];
}

export interface ClaraThemeDocument {
  version: typeof THEME_DOCUMENT_VERSION;
  id: string;
  name: string;
  description?: string;
  author?: string;
  mode: ThemeMode;
  /** Set by the library for bundled themes; ignored on import. */
  builtIn?: boolean;
  tokens: Record<string, string>;
  groups: Record<string, ThemeGroupOverride>;
  monaco?: ThemeMonacoDefinition;
  assets?: Record<string, string>;
}

export interface ThemeValidationIssue {
  path: string;
  message: string;
}

export interface ThemeValidationResult {
  ok: boolean;
  doc: ClaraThemeDocument | null;
  errors: ThemeValidationIssue[];
  warnings: ThemeValidationIssue[];
}

export interface ValidateThemeOptions {
  /** Group ids accepted in `groups`; defaults to the generated registry. */
  knownGroupIds?: readonly string[];
  /** When set, forces `builtIn` on the result (library use). */
  builtIn?: boolean;
}

export const THEME_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
export const THEME_ASSET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/**
 * Embedded image asset: strict `data:image/<type>;base64,<base64>` with no whitespace, so the
 * value can be interpolated into `url("…")` without ever terminating the CSS string.
 */
export const THEME_ASSET_DATA_URL_PATTERN = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+=*$/i;

/** True for a well-formed embedded image asset (see {@link THEME_ASSET_DATA_URL_PATTERN}). */
export function isThemeAssetDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length <= THEME_ASSET_DATA_URL_MAX_CHARS && THEME_ASSET_DATA_URL_PATTERN.test(value);
}
export const THEME_NAME_MAX_CHARS = 80;
export const THEME_DESCRIPTION_MAX_CHARS = 400;
export const THEME_TOKEN_VALUE_MAX_CHARS = 400;
/** Base64 of a 24 MB image is ~32 M chars; bundles above this are rejected on import. */
export const THEME_ASSET_DATA_URL_MAX_CHARS = 34 * 1024 * 1024;
export const THEME_MONACO_RULES_MAX = 200;

const UNSAFE_TOKEN_VALUE = /[;{}<>]|\/\*|url\s*\(|expression\s*\(|javascript\s*:|@import|@/i;
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const HEX_COLOR_BARE = /^#?(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const COLOR_FUNCTION = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|var|light-dark)\s*\(/i;
const COLOR_KEYWORDS = new Set([
  'transparent',
  'currentcolor',
  'inherit',
  'initial',
  'unset',
  'white',
  'black',
  'red',
  'green',
  'blue',
  'gray',
  'grey',
  'silver',
  'orange',
  'yellow',
  'purple',
  'teal',
  'navy',
  'maroon',
  'olive',
  'lime',
  'aqua',
  'fuchsia',
  'gold',
  'coral',
  'salmon',
  'tomato',
  'crimson',
  'indigo',
  'violet',
  'khaki',
  'beige',
  'ivory',
  'tan',
  'wheat',
  'sienna',
  'chocolate',
  'brown',
]);

/** Safe for interpolation into a `--t-*: <value>;` declaration. */
export function isSafeThemeTokenValue(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const v = value.trim();
  if (!v || v.length > THEME_TOKEN_VALUE_MAX_CHARS) {
    return false;
  }
  return !UNSAFE_TOKEN_VALUE.test(v);
}

/** Loose "does this read as a color" check for editor hints (not a parser). */
export function looksLikeCssColor(value: string): boolean {
  const v = value.trim();
  if (HEX_COLOR.test(v)) {
    return true;
  }
  if (COLOR_FUNCTION.test(v)) {
    return true;
  }
  return COLOR_KEYWORDS.has(v.toLowerCase());
}

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR.test(value.trim());
}

/** Normalize `#rrggbb[aa]` / `rrggbb[aa]` to lowercase hex without `#` (Monaco rule form). */
export function normalizeBareHex(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const v = value.trim();
  if (!HEX_COLOR_BARE.test(v)) {
    return null;
  }
  return (v.charAt(0) === '#' ? v.slice(1) : v).toLowerCase();
}

/** Normalize a Monaco color value to `#rrggbb[aa]`, expanding 3/4-digit shorthand. */
export function normalizeMonacoHex(value: unknown): string | null {
  if (!isHexColor(value)) {
    return null;
  }
  const v = value.trim().slice(1).toLowerCase();
  if (v.length === 3 || v.length === 4) {
    let out = '#';
    for (const ch of v.split('')) {
      out += ch + ch;
    }
    return out;
  }
  return `#${v}`;
}

export function slugifyThemeId(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (THEME_ID_PATTERN.test(slug)) {
    return slug;
  }
  return slug.length === 1 ? `${slug}-theme` : 'custom-theme';
}

export function emptyThemeDocument(id: string, name: string, mode: ThemeMode): ClaraThemeDocument {
  return {
    version: THEME_DOCUMENT_VERSION,
    id,
    name,
    mode,
    tokens: {},
    groups: {},
    assets: {},
  };
}

export function cloneThemeDocument(doc: ClaraThemeDocument): ClaraThemeDocument {
  return JSON.parse(JSON.stringify(doc)) as ClaraThemeDocument;
}

/** Group ids in `doc` with an enabled background overlay that references a known asset. */
export function themeBackgroundGroupIds(doc: ClaraThemeDocument): string[] {
  const out: string[] = [];
  for (const groupId of Object.keys(doc.groups)) {
    const bg = doc.groups[groupId]?.background;
    if (bg && bg.enabled && bg.asset && doc.assets && doc.assets[bg.asset]) {
      out.push(groupId);
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateTokenMap(
  raw: unknown,
  path: string,
  errors: ThemeValidationIssue[],
  warnings: ThemeValidationIssue[],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === undefined) {
    return out;
  }
  if (!isRecord(raw)) {
    errors.push({ path, message: 'must be an object of token name → CSS value' });
    return out;
  }
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (!isThemeTokenName(key)) {
      warnings.push({ path: `${path}.${key}`, message: 'unknown token (dropped)' });
      continue;
    }
    if (!isSafeThemeTokenValue(value)) {
      warnings.push({ path: `${path}.${key}`, message: 'unsafe or empty value (dropped)' });
      continue;
    }
    const def = themeTokenDef(key);
    const trimmed = value.trim();
    if (def && def.kind === 'color' && !looksLikeCssColor(trimmed)) {
      warnings.push({ path: `${path}.${key}`, message: 'does not look like a CSS color' });
    }
    out[key] = trimmed;
  }
  return out;
}

function validateBackground(
  raw: unknown,
  path: string,
  assets: Record<string, string>,
  warnings: ThemeValidationIssue[],
): ThemeGroupBackground | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!isRecord(raw)) {
    warnings.push({ path, message: 'background must be an object (dropped)' });
    return undefined;
  }
  const enabled = raw['enabled'] === true;
  const assetRaw = raw['asset'];
  const asset = typeof assetRaw === 'string' && THEME_ASSET_NAME_PATTERN.test(assetRaw) ? assetRaw : '';
  if (assetRaw !== undefined && assetRaw !== '' && !asset) {
    warnings.push({ path: `${path}.asset`, message: 'invalid asset name (cleared)' });
  }
  if (enabled && asset && !assets[asset]) {
    warnings.push({ path: `${path}.asset`, message: `references missing asset "${asset}"` });
  }
  const opacityRaw = raw['opacity'];
  let opacity = 0.35;
  if (typeof opacityRaw === 'number' && Number.isFinite(opacityRaw)) {
    // Accept 0–1 fractions; whole numbers above 1 read as percentages (40 → 0.4). Anything
    // else above 1 (1.5) is an out-of-range fraction and clamps, not a 1.5 % overlay.
    opacity = opacityRaw > 1 && Number.isInteger(opacityRaw) ? opacityRaw / 100 : opacityRaw;
    opacity = Math.min(1, Math.max(0, opacity));
  } else if (opacityRaw !== undefined) {
    warnings.push({ path: `${path}.opacity`, message: 'must be a number (defaulted)' });
  }
  const fitRaw = raw['fit'];
  const fit: ThemeBackgroundFit =
    typeof fitRaw === 'string' && THEME_BACKGROUND_FITS.indexOf(fitRaw as ThemeBackgroundFit) >= 0
      ? (fitRaw as ThemeBackgroundFit)
      : 'cover';
  if (fitRaw !== undefined && fit !== fitRaw) {
    warnings.push({ path: `${path}.fit`, message: 'unknown fit (defaulted to cover)' });
  }
  return { enabled, asset, opacity: +opacity.toFixed(3), fit };
}

function validateGroups(
  raw: unknown,
  knownGroupIds: readonly string[],
  assets: Record<string, string>,
  errors: ThemeValidationIssue[],
  warnings: ThemeValidationIssue[],
): Record<string, ThemeGroupOverride> {
  const out: Record<string, ThemeGroupOverride> = {};
  if (raw === undefined) {
    return out;
  }
  if (!isRecord(raw)) {
    errors.push({ path: 'groups', message: 'must be an object of group id → override' });
    return out;
  }
  const known = new Set(knownGroupIds);
  for (const groupId of Object.keys(raw)) {
    const path = `groups.${groupId}`;
    if (!known.has(groupId)) {
      warnings.push({ path, message: 'unknown group id (dropped)' });
      continue;
    }
    const entry = raw[groupId];
    if (!isRecord(entry)) {
      warnings.push({ path, message: 'must be an object (dropped)' });
      continue;
    }
    const override: ThemeGroupOverride = {};
    const tokens = validateTokenMap(entry['tokens'], `${path}.tokens`, errors, warnings);
    if (Object.keys(tokens).length > 0) {
      override.tokens = tokens;
    }
    const cssRaw = entry['css'];
    if (typeof cssRaw === 'string' && cssRaw.trim()) {
      let css = cssRaw;
      if (css.length > THEME_GROUP_CSS_MAX_CHARS) {
        warnings.push({ path: `${path}.css`, message: `truncated to ${THEME_GROUP_CSS_MAX_CHARS} characters` });
        css = css.slice(0, THEME_GROUP_CSS_MAX_CHARS);
      }
      const scoped = scopeThemeCss(css, `[data-theme-group="${groupId}"]`);
      for (const w of scoped.warnings) {
        warnings.push({ path: `${path}.css`, message: w });
      }
      override.css = css;
    } else if (cssRaw !== undefined && typeof cssRaw !== 'string') {
      warnings.push({ path: `${path}.css`, message: 'must be a string (dropped)' });
    }
    const background = validateBackground(entry['background'], `${path}.background`, assets, warnings);
    if (background) {
      override.background = background;
    }
    if (override.tokens || override.css || override.background) {
      out[groupId] = override;
    }
  }
  return out;
}

function validateAssets(raw: unknown, errors: ThemeValidationIssue[], warnings: ThemeValidationIssue[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === undefined || raw === null) {
    return out;
  }
  if (!isRecord(raw)) {
    errors.push({ path: 'assets', message: 'must be an object of asset name → file name or data URL' });
    return out;
  }
  for (const name of Object.keys(raw)) {
    const value = raw[name];
    if (!THEME_ASSET_NAME_PATTERN.test(name)) {
      warnings.push({ path: `assets.${name}`, message: 'invalid asset name (dropped)' });
      continue;
    }
    if (typeof value !== 'string' || !value) {
      warnings.push({ path: `assets.${name}`, message: 'must be a non-empty string (dropped)' });
      continue;
    }
    if (/^data:/i.test(value)) {
      if (value.length > THEME_ASSET_DATA_URL_MAX_CHARS) {
        warnings.push({ path: `assets.${name}`, message: 'embedded image too large (dropped)' });
        continue;
      }
      if (!isThemeAssetDataUrl(value)) {
        warnings.push({ path: `assets.${name}`, message: 'embedded image must be a data:image/…;base64 URL (dropped)' });
        continue;
      }
      out[name] = value;
      continue;
    }
    if (THEME_ASSET_NAME_PATTERN.test(value)) {
      out[name] = value;
      continue;
    }
    warnings.push({ path: `assets.${name}`, message: 'must be a file name or data:image URL (dropped)' });
  }
  return out;
}

/** Stock Monaco theme that matches an app theme mode. */
export function defaultMonacoBaseForMode(mode: ThemeMode): ThemeMonacoBase {
  return mode === 'light' ? 'vs' : 'vs-dark';
}

function validateMonaco(raw: unknown, mode: ThemeMode, warnings: ThemeValidationIssue[]): ThemeMonacoDefinition | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!isRecord(raw)) {
    warnings.push({ path: 'monaco', message: 'must be an object (dropped)' });
    return undefined;
  }
  const fallbackBase = defaultMonacoBaseForMode(mode);
  const baseRaw = raw['base'];
  const base: ThemeMonacoBase =
    typeof baseRaw === 'string' && THEME_MONACO_BASES.indexOf(baseRaw as ThemeMonacoBase) >= 0
      ? (baseRaw as ThemeMonacoBase)
      : fallbackBase;
  if (baseRaw !== undefined && base !== baseRaw) {
    warnings.push({ path: 'monaco.base', message: `unknown base (defaulted to ${fallbackBase})` });
  }
  const colors: Record<string, string> = {};
  const colorsRaw = raw['colors'];
  if (isRecord(colorsRaw)) {
    for (const key of Object.keys(colorsRaw)) {
      if (!/^[A-Za-z][A-Za-z0-9.]*$/.test(key)) {
        warnings.push({ path: `monaco.colors.${key}`, message: 'invalid color id (dropped)' });
        continue;
      }
      const hex = normalizeMonacoHex(colorsRaw[key]);
      if (!hex) {
        warnings.push({ path: `monaco.colors.${key}`, message: 'must be a hex color (dropped)' });
        continue;
      }
      colors[key] = hex;
    }
  } else if (colorsRaw !== undefined) {
    warnings.push({ path: 'monaco.colors', message: 'must be an object (dropped)' });
  }
  const rules: ThemeMonacoRule[] = [];
  const rulesRaw = raw['rules'];
  if (Array.isArray(rulesRaw)) {
    for (let i = 0; i < rulesRaw.length && rules.length < THEME_MONACO_RULES_MAX; i++) {
      const r = rulesRaw[i];
      if (!isRecord(r) || typeof r['token'] !== 'string' || !/^[A-Za-z0-9._-]*$/.test(r['token'])) {
        warnings.push({ path: `monaco.rules[${i}]`, message: 'invalid rule (dropped)' });
        continue;
      }
      const rule: ThemeMonacoRule = { token: r['token'] };
      const fg = normalizeBareHex(r['foreground']);
      const bg = normalizeBareHex(r['background']);
      if (fg) rule.foreground = fg;
      if (bg) rule.background = bg;
      if (typeof r['fontStyle'] === 'string' && /^[a-z ]{0,40}$/.test(r['fontStyle'])) {
        rule.fontStyle = r['fontStyle'];
      }
      rules.push(rule);
    }
    if (rulesRaw.length > THEME_MONACO_RULES_MAX) {
      warnings.push({ path: 'monaco.rules', message: `only the first ${THEME_MONACO_RULES_MAX} rules are kept` });
    }
  } else if (rulesRaw !== undefined) {
    warnings.push({ path: 'monaco.rules', message: 'must be an array (dropped)' });
  }
  if (baseRaw === undefined && Object.keys(colors).length === 0 && rules.length === 0) {
    // `monaco: {}` would otherwise replace the token-derived palette with a bare stock theme.
    warnings.push({ path: 'monaco', message: 'empty; the editor palette stays derived from the tokens' });
    return undefined;
  }
  return { base, colors, rules };
}

/**
 * Coerce unknown JSON into a {@link ClaraThemeDocument}. Structural problems are errors
 * (`ok: false`, `doc: null`); recoverable problems are warnings and the offending piece is
 * dropped or defaulted.
 */
export function validateThemeDocument(raw: unknown, options: ValidateThemeOptions = {}): ThemeValidationResult {
  const errors: ThemeValidationIssue[] = [];
  const warnings: ThemeValidationIssue[] = [];
  if (!isRecord(raw)) {
    errors.push({ path: '', message: 'theme must be a JSON object' });
    return { ok: false, doc: null, errors, warnings };
  }

  const versionRaw = raw['version'];
  if (versionRaw === undefined) {
    warnings.push({ path: 'version', message: 'missing; assumed 1' });
  } else if (versionRaw !== THEME_DOCUMENT_VERSION) {
    errors.push({ path: 'version', message: `unsupported theme version ${String(versionRaw)}` });
  }

  const idRaw = raw['id'];
  const nameRaw = raw['name'];
  let name = typeof nameRaw === 'string' ? nameRaw.trim().slice(0, THEME_NAME_MAX_CHARS) : '';
  let id = typeof idRaw === 'string' ? idRaw.trim() : '';
  if (!id && name) {
    id = slugifyThemeId(name);
    warnings.push({ path: 'id', message: `missing; derived "${id}" from name` });
  }
  if (!THEME_ID_PATTERN.test(id)) {
    if (id) {
      const slug = slugifyThemeId(id);
      warnings.push({ path: 'id', message: `"${id}" normalized to "${slug}"` });
      id = slug;
    } else {
      errors.push({ path: 'id', message: 'required (lowercase letters, digits, hyphens)' });
    }
  }
  if (!name) {
    if (id) {
      name = id;
      warnings.push({ path: 'name', message: 'missing; using id' });
    } else {
      errors.push({ path: 'name', message: 'required' });
    }
  }

  const modeRaw = raw['mode'];
  let mode: ThemeMode = 'dark';
  if (modeRaw === 'dark' || modeRaw === 'light') {
    mode = modeRaw;
  } else if (modeRaw === undefined) {
    warnings.push({ path: 'mode', message: 'missing; assumed dark' });
  } else {
    errors.push({ path: 'mode', message: 'must be "dark" or "light"' });
  }

  const assets = validateAssets(raw['assets'], errors, warnings);
  const tokens = validateTokenMap(raw['tokens'], 'tokens', errors, warnings);
  if (raw['tokens'] === undefined) {
    warnings.push({ path: 'tokens', message: 'missing; theme inherits every built-in token' });
  }
  const groups = validateGroups(raw['groups'], options.knownGroupIds ?? THEME_GROUP_IDS, assets, errors, warnings);
  const monaco = validateMonaco(raw['monaco'], mode, warnings);

  const descriptionRaw = raw['description'];
  const authorRaw = raw['author'];

  if (errors.length > 0) {
    return { ok: false, doc: null, errors, warnings };
  }

  const doc: ClaraThemeDocument = {
    version: THEME_DOCUMENT_VERSION,
    id,
    name,
    mode,
    tokens,
    groups,
  };
  if (typeof descriptionRaw === 'string' && descriptionRaw.trim()) {
    doc.description = descriptionRaw.trim().slice(0, THEME_DESCRIPTION_MAX_CHARS);
  }
  if (typeof authorRaw === 'string' && authorRaw.trim()) {
    doc.author = authorRaw.trim().slice(0, THEME_NAME_MAX_CHARS);
  }
  if (monaco) {
    doc.monaco = monaco;
  }
  if (Object.keys(assets).length > 0) {
    doc.assets = assets;
  }
  if (options.builtIn) {
    doc.builtIn = true;
  }
  return { ok: true, doc, errors, warnings };
}

/** Tokens in the catalog that `doc` does not define (inherited from the mode built-in). */
export function missingThemeTokens(doc: ClaraThemeDocument): string[] {
  return THEME_TOKENS.filter((t) => !(t.name in doc.tokens)).map((t) => t.name);
}
