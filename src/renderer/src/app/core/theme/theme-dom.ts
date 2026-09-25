/**
 * DOM side of the theme engine: writes a resolved theme into a `Document`.
 * Pure functions (no Angular) so `main.ts` can paint the built-in theme before bootstrap and
 * specs can drive a jsdom document directly.
 */
import {
  CLARA_DARK_THEME,
  DEFAULT_THEME_ID,
  cssColorToHex,
  findBuiltInTheme,
  resolveThemeDocument,
  themeStylesheetText,
  type ClaraThemeDocument,
  type ResolvedTheme,
  type ThemeAssetUrlResolver,
  type ThemeColorResolver,
} from '@shared/theme';

export const THEME_TOKENS_STYLE_ID = 'clara-theme-tokens';
export const THEME_GROUPS_STYLE_ID = 'clara-theme-groups';
export const THEME_ID_ATTR = 'data-theme-id';
export const THEME_MODE_ATTR = 'data-theme-mode';
export const THEME_REVISION_ATTR = 'data-theme-revision';

const LEGACY_THEME_CLASSES = ['theme-woodland', 'theme-classical', 'theme-dark-classical'];

/** `clara-theme://asset/<themeId>/<file>` for on-disk assets; `data:` URLs pass through. */
export const rendererThemeAssetUrl: ThemeAssetUrlResolver = (themeId, _asset, assetValue) => {
  if (/^data:image\//i.test(assetValue)) {
    return assetValue;
  }
  return `clara-theme://asset/${encodeURIComponent(themeId)}/${encodeURIComponent(assetValue)}`;
};

function upsertStyle(doc: Document, id: string, css: string): void {
  const head = doc.head ?? doc.getElementsByTagName('head')[0];
  if (!head) {
    return;
  }
  let el = doc.getElementById(id) as HTMLStyleElement | null;
  if (!el) {
    el = doc.createElement('style');
    el.id = id;
  }
  if (el.textContent !== css) {
    el.textContent = css;
  }
  // Re-append so theme sheets always follow the bundled global styles.
  head.appendChild(el);
}

/** Paint `resolved` into `doc`: token + group stylesheets and root attributes. */
export function applyResolvedThemeToDocument(
  doc: Document,
  resolved: ResolvedTheme,
  assetUrl: ThemeAssetUrlResolver = rendererThemeAssetUrl,
): void {
  const { tokensCss, groupsCss } = themeStylesheetText(resolved, assetUrl);
  upsertStyle(doc, THEME_TOKENS_STYLE_ID, tokensCss);
  upsertStyle(doc, THEME_GROUPS_STYLE_ID, groupsCss);
  const root = doc.documentElement;
  root.setAttribute(THEME_ID_ATTR, resolved.id);
  root.setAttribute(THEME_MODE_ATTR, resolved.mode);
  root.setAttribute('data-bs-theme', resolved.mode);
  root.style.colorScheme = resolved.mode;
  for (const cls of LEGACY_THEME_CLASSES) {
    root.classList.remove(cls);
  }
}

/** Synchronous first paint with a built-in theme (used before Angular bootstraps). */
export function applyBuiltInThemeSync(doc: Document, themeId: string = DEFAULT_THEME_ID): ClaraThemeDocument {
  const theme = findBuiltInTheme(themeId) ?? CLARA_DARK_THEME;
  applyResolvedThemeToDocument(doc, resolveThemeDocument(theme));
  return theme;
}

/**
 * Resolves arbitrary CSS color expressions (e.g. `color-mix(...)`) through the live cascade by
 * assigning them to a hidden probe element and reading the computed color.
 */
export function createDomColorResolver(doc: Document): ThemeColorResolver {
  let probe: HTMLElement | null = null;
  return (value: string): string | null => {
    const body = doc.body;
    if (!body) {
      return null;
    }
    if (!probe || !probe.isConnected) {
      probe = doc.createElement('span');
      probe.setAttribute('aria-hidden', 'true');
      probe.style.position = 'absolute';
      probe.style.visibility = 'hidden';
      probe.style.pointerEvents = 'none';
      probe.style.width = '0';
      probe.style.height = '0';
      body.appendChild(probe);
    }
    probe.style.color = '';
    probe.style.color = value;
    if (!probe.style.color) {
      return null;
    }
    try {
      const computed = doc.defaultView?.getComputedStyle(probe).color ?? '';
      return cssColorToHex(computed);
    } catch {
      return null;
    }
  };
}
