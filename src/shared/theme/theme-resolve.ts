/**
 * Turn a theme document into the concrete pieces the engine applies: the merged token map
 * (mode built-in under the theme), per-group scoped token/CSS/background data, and the
 * stylesheet text. String-only so it is testable without a DOM and reusable by main.
 */

import { builtInThemeForMode } from './builtin';
import { scopeThemeCss } from './theme-css-scope';
import type { ClaraThemeDocument, ThemeBackgroundFit, ThemeMode } from './theme-document';
import { THEME_GROUPS } from './theme-registry.generated';
import type { ThemeGroupDef } from './theme-registry-types';

export interface ResolvedThemeBackground {
  asset: string;
  /** Raw asset value from the document (file name or data URL). */
  assetValue: string;
  opacity: number;
  fit: ThemeBackgroundFit;
  /** Inner selectors whose backgrounds go transparent while the overlay is active. */
  clearSelectors: string[];
}

export interface ResolvedThemeGroup {
  id: string;
  selector: string;
  tokens: Record<string, string>;
  /** Sanitized, scoped CSS (may be empty). */
  css: string;
  cssWarnings: string[];
  background: ResolvedThemeBackground | null;
}

export interface ResolvedTheme {
  id: string;
  name: string;
  mode: ThemeMode;
  /** Mode built-in tokens with the theme's tokens layered on top. */
  tokens: Record<string, string>;
  groups: ResolvedThemeGroup[];
}

export interface ResolveThemeOptions {
  /** Registry to resolve against (defaults to the generated one). */
  groups?: readonly ThemeGroupDef[];
}

export function resolveThemeDocument(doc: ClaraThemeDocument, options: ResolveThemeOptions = {}): ResolvedTheme {
  const registry = options.groups ?? THEME_GROUPS;
  const base = builtInThemeForMode(doc.mode);
  const tokens: Record<string, string> = { ...base.tokens, ...doc.tokens };

  const groups: ResolvedThemeGroup[] = [];
  for (const def of registry) {
    const override = doc.groups[def.id];
    if (!override) {
      continue;
    }
    const groupTokens: Record<string, string> = { ...(override.tokens ?? {}) };
    const scoped = override.css ? scopeThemeCss(override.css, def.selector) : { css: '', warnings: [] };
    let background: ResolvedThemeBackground | null = null;
    const bg = override.background;
    if (def.supportsBackground && bg && bg.enabled && bg.asset) {
      const assetValue = doc.assets?.[bg.asset];
      if (assetValue) {
        background = {
          asset: bg.asset,
          assetValue,
          opacity: bg.opacity,
          fit: bg.fit,
          clearSelectors: def.backgroundClear ? def.backgroundClear.slice() : [],
        };
      }
    }
    if (Object.keys(groupTokens).length === 0 && !scoped.css && !background) {
      continue;
    }
    groups.push({
      id: def.id,
      selector: def.selector,
      tokens: groupTokens,
      css: scoped.css,
      cssWarnings: scoped.warnings,
      background,
    });
  }

  return { id: doc.id, name: doc.name, mode: doc.mode, tokens, groups };
}

/** Maps a background asset to a URL the renderer may load (`clara-theme://…` or a `data:` URL). */
export type ThemeAssetUrlResolver = (themeId: string, asset: string, assetValue: string) => string | null;

function declarations(tokens: Record<string, string>, indent = '  '): string {
  return Object.keys(tokens)
    .sort()
    .map((name) => `${indent}${name}: ${tokens[name]};`)
    .join('\n');
}

/**
 * Quote `value` as a CSS `<string>`. Backslashes, quotes, and line terminators become hex
 * escapes so no input can close the string or start a new rule.
 */
export function cssQuote(value: string): string {
  return `"${value.replace(/[\\"\n\r\f]/g, (ch) => `\\${ch.charCodeAt(0).toString(16)} `)}"`;
}

function backgroundRules(selector: string, url: string, bg: ResolvedThemeBackground): string {
  const size = bg.fit === 'tile' ? 'auto' : bg.fit === 'center' ? 'auto' : bg.fit;
  const repeat = bg.fit === 'tile' ? 'repeat' : 'no-repeat';
  const lines = [
    `${selector} {`,
    '  isolation: isolate;',
    '}',
    `${selector}::before {`,
    '  content: "";',
    '  position: absolute;',
    '  inset: 0;',
    '  z-index: -1;',
    '  pointer-events: none;',
    `  background-image: url(${cssQuote(url)});`,
    `  background-size: ${size};`,
    `  background-repeat: ${repeat};`,
    '  background-position: center;',
    `  opacity: ${bg.opacity};`,
    '}',
  ];
  if (bg.clearSelectors.length > 0) {
    const inner = bg.clearSelectors.map((s) => `${selector} ${s}`).join(',\n');
    lines.push(`${inner} {`, '  background-color: transparent !important;', '  background-image: none !important;', '}');
  }
  return lines.join('\n');
}

/**
 * Stylesheet text for a resolved theme.
 * - `tokensCss`: `:root` tokens, per-group token overrides, and background overlay rules.
 * - `groupsCss`: concatenated scoped advanced CSS.
 */
export function themeStylesheetText(
  resolved: ResolvedTheme,
  assetUrl: ThemeAssetUrlResolver,
): { tokensCss: string; groupsCss: string } {
  const tokenBlocks: string[] = [`:root {\n${declarations(resolved.tokens)}\n}`];
  const groupBlocks: string[] = [];
  for (const group of resolved.groups) {
    if (Object.keys(group.tokens).length > 0) {
      tokenBlocks.push(`${group.selector} {\n${declarations(group.tokens)}\n}`);
    }
    if (group.background) {
      const url = assetUrl(resolved.id, group.background.asset, group.background.assetValue);
      if (url) {
        tokenBlocks.push(backgroundRules(group.selector, url, group.background));
      }
    }
    if (group.css) {
      groupBlocks.push(`/* ${group.id} */\n${group.css}`);
    }
  }
  return { tokensCss: tokenBlocks.join('\n\n'), groupsCss: groupBlocks.join('\n\n') };
}
