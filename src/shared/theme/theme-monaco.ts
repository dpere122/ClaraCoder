/**
 * Monaco palette derivation: when a theme document has no explicit `monaco` block, build one
 * from the app tokens so the editor matches the rest of the window.
 *
 * Token values may be `var(--t-…)` references, `rgba()`, `hsl()`, or `color-mix()`. Hex /
 * rgb / hsl / `color(srgb …)` values are parsed here; anything else is handed to an optional
 * resolver (the renderer resolves through the DOM) and skipped when that returns null.
 */

import type { ClaraThemeDocument, ThemeMonacoDefinition, ThemeMonacoRule } from './theme-document';

export const MONACO_APP_THEME_NAME = 'clara-app-theme';

/** Resolve an arbitrary CSS color string to `#rrggbb[aa]`, or null when unknown. */
export type ThemeColorResolver = (cssValue: string) => string | null;

const NAMED_COLORS: Readonly<Record<string, string>> = {
  transparent: '#00000000',
  white: '#ffffff',
  black: '#000000',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  gray: '#808080',
  grey: '#808080',
  silver: '#c0c0c0',
  orange: '#ffa500',
  yellow: '#ffff00',
  purple: '#800080',
};

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function hex2(n: number): string {
  const h = clamp255(n).toString(16);
  return h.length === 1 ? `0${h}` : h;
}

function parseChannel(raw: string, scale: number): number | null {
  const v = raw.trim();
  if (!v) {
    return null;
  }
  if (v.charAt(v.length - 1) === '%') {
    const pct = parseFloat(v.slice(0, -1));
    return Number.isFinite(pct) ? (pct / 100) * scale : null;
  }
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function parseAlpha(raw: string | undefined): number {
  if (raw === undefined) {
    return 1;
  }
  const v = raw.trim();
  if (!v) {
    return 1;
  }
  if (v.charAt(v.length - 1) === '%') {
    const pct = parseFloat(v.slice(0, -1));
    return Number.isFinite(pct) ? Math.max(0, Math.min(1, pct / 100)) : 1;
  }
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
}

function toHex(r: number, g: number, b: number, a: number): string {
  const base = `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  return a >= 0.999 ? base : `${base}${hex2(a * 255)}`;
}

function splitArgs(inner: string): { channels: string[]; alpha?: string } {
  const slash = inner.indexOf('/');
  const head = slash >= 0 ? inner.slice(0, slash) : inner;
  const alphaFromSlash = slash >= 0 ? inner.slice(slash + 1) : undefined;
  const parts = head
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (alphaFromSlash !== undefined) {
    return { channels: parts, alpha: alphaFromSlash };
  }
  if (parts.length === 4) {
    return { channels: parts.slice(0, 3), alpha: parts[3] };
  }
  return { channels: parts };
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = (((h % 360) + 360) % 360) / 360;
  const sat = Math.max(0, Math.min(1, s));
  const lig = Math.max(0, Math.min(1, l));
  if (sat === 0) {
    return [lig * 255, lig * 255, lig * 255];
  }
  const q = lig < 0.5 ? lig * (1 + sat) : lig + sat - lig * sat;
  const p = 2 * lig - q;
  const channel = (t0: number): number => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [channel(hue + 1 / 3) * 255, channel(hue) * 255, channel(hue - 1 / 3) * 255];
}

/** Parse hex, rgb[a](), hsl[a](), color(srgb …), and a few keywords into `#rrggbb[aa]`. */
export function cssColorToHex(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (!v) {
    return null;
  }
  if (NAMED_COLORS[v]) {
    return NAMED_COLORS[v]!;
  }
  if (v.charAt(0) === '#') {
    const body = v.slice(1);
    if (!/^[0-9a-f]+$/.test(body)) {
      return null;
    }
    if (body.length === 3 || body.length === 4) {
      let expanded = '';
      for (const ch of body.split('')) {
        expanded += ch + ch;
      }
      return cssColorToHex(`#${expanded}`);
    }
    if (body.length === 6) {
      return `#${body}`;
    }
    if (body.length === 8) {
      return body.slice(6) === 'ff' ? `#${body.slice(0, 6)}` : `#${body}`;
    }
    return null;
  }
  const fn = /^([a-z-]+)\((.*)\)$/.exec(v);
  if (!fn) {
    return null;
  }
  const name = fn[1]!;
  const { channels, alpha } = splitArgs(fn[2]!);
  if (name === 'rgb' || name === 'rgba') {
    if (channels.length !== 3) return null;
    const r = parseChannel(channels[0]!, 255);
    const g = parseChannel(channels[1]!, 255);
    const b = parseChannel(channels[2]!, 255);
    if (r === null || g === null || b === null) return null;
    return toHex(r, g, b, parseAlpha(alpha));
  }
  if (name === 'hsl' || name === 'hsla') {
    if (channels.length !== 3) return null;
    const h = parseFloat(channels[0]!);
    const s = parseChannel(channels[1]!, 1);
    const l = parseChannel(channels[2]!, 1);
    if (!Number.isFinite(h) || s === null || l === null) return null;
    const [r, g, b] = hslToRgb(h, s > 1 ? s / 100 : s, l > 1 ? l / 100 : l);
    return toHex(r, g, b, parseAlpha(alpha));
  }
  if (name === 'color') {
    if (channels.length !== 4 || channels[0] !== 'srgb') return null;
    const r = parseChannel(channels[1]!, 1);
    const g = parseChannel(channels[2]!, 1);
    const b = parseChannel(channels[3]!, 1);
    if (r === null || g === null || b === null) return null;
    return toHex(r * 255, g * 255, b * 255, parseAlpha(alpha));
  }
  return null;
}

/** Multiply the alpha of a `#rrggbb[aa]` color. */
export function hexWithAlpha(hex: string, alpha: number): string {
  const parsed = cssColorToHex(hex);
  if (!parsed) {
    return hex;
  }
  const existing = parsed.length === 9 ? parseInt(parsed.slice(7, 9), 16) / 255 : 1;
  const a = Math.max(0, Math.min(1, existing * alpha));
  return `${parsed.slice(0, 7)}${hex2(a * 255)}`;
}

const VAR_REF = /^var\(\s*(--[a-zA-Z0-9-]+)\s*(?:,\s*(.*))?\)$/;

/**
 * Resolve a token to a hex color, following `var(--t-…)` chains through `tokens` (theme over
 * base). Falls back to `resolver` for values this module cannot parse (e.g. `color-mix`).
 */
export function resolveThemeTokenColor(
  tokens: Record<string, string>,
  tokenName: string,
  resolver?: ThemeColorResolver,
  depth = 0,
): string | null {
  if (depth > 8) {
    return null;
  }
  const raw = tokens[tokenName];
  if (!raw) {
    return null;
  }
  const value = raw.trim();
  const ref = VAR_REF.exec(value);
  if (ref) {
    const inner = resolveThemeTokenColor(tokens, ref[1]!, resolver, depth + 1);
    if (inner) {
      return inner;
    }
    return ref[2] ? cssColorToHex(ref[2]) : null;
  }
  const direct = cssColorToHex(value);
  if (direct) {
    return direct;
  }
  return resolver ? resolver(value) : null;
}

interface MonacoColorMapping {
  color: string;
  token: string;
  alpha?: number;
}

/** Monaco color id → app token (with optional alpha multiplier). */
export const MONACO_COLOR_TOKEN_MAP: readonly MonacoColorMapping[] = [
  { color: 'editor.background', token: '--t-code-bg' },
  { color: 'editor.foreground', token: '--t-code-text' },
  { color: 'editorGutter.background', token: '--t-code-bg' },
  { color: 'editorStickyScroll.background', token: '--t-code-bg' },
  { color: 'minimap.background', token: '--t-code-bg' },
  { color: 'editorLineNumber.foreground', token: '--t-text-muted' },
  { color: 'editorLineNumber.activeForeground', token: '--t-primary' },
  { color: 'editorCursor.foreground', token: '--t-primary' },
  { color: 'editor.selectionBackground', token: '--t-selection-bg' },
  { color: 'editor.inactiveSelectionBackground', token: '--t-selection-bg', alpha: 0.6 },
  { color: 'editor.lineHighlightBackground', token: '--t-hover-bg' },
  { color: 'editorIndentGuide.background1', token: '--t-border-subtle' },
  { color: 'editorIndentGuide.activeBackground1', token: '--t-border' },
  { color: 'editorWhitespace.foreground', token: '--t-border-subtle' },
  { color: 'editorBracketMatch.border', token: '--t-secondary' },
  { color: 'editorBracketMatch.background', token: '--t-hover-bg' },
  { color: 'editorWidget.background', token: '--t-bg-surface' },
  { color: 'editorWidget.border', token: '--t-border' },
  { color: 'editorSuggestWidget.background', token: '--t-bg-surface' },
  { color: 'editorSuggestWidget.border', token: '--t-border' },
  { color: 'editorSuggestWidget.foreground', token: '--t-fg' },
  { color: 'editorSuggestWidget.selectedBackground', token: '--t-active-bg' },
  { color: 'editorHoverWidget.background', token: '--t-bg-surface' },
  { color: 'editorHoverWidget.border', token: '--t-border' },
  { color: 'scrollbarSlider.background', token: '--t-border', alpha: 0.6 },
  { color: 'scrollbarSlider.hoverBackground', token: '--t-secondary', alpha: 0.6 },
  { color: 'scrollbarSlider.activeBackground', token: '--t-secondary', alpha: 0.8 },
  { color: 'editor.findMatchBackground', token: '--t-secondary', alpha: 0.35 },
  { color: 'editor.findMatchHighlightBackground', token: '--t-secondary', alpha: 0.2 },
  { color: 'diffEditor.insertedTextBackground', token: '--t-confirm', alpha: 0.2 },
  { color: 'diffEditor.removedTextBackground', token: '--t-log-level-error', alpha: 0.2 },
  { color: 'diffEditor.insertedLineBackground', token: '--t-confirm', alpha: 0.12 },
  { color: 'diffEditor.removedLineBackground', token: '--t-log-level-error', alpha: 0.12 },
  { color: 'editorError.foreground', token: '--t-log-level-error' },
  { color: 'editorWarning.foreground', token: '--t-log-level-warning' },
  { color: 'focusBorder', token: '--t-secondary' },
  { color: 'input.background', token: '--t-input-bg' },
  { color: 'input.foreground', token: '--t-input-fg' },
  { color: 'input.border', token: '--t-border' },
];

interface MonacoRuleMapping {
  scope: string;
  token: string;
  fontStyle?: string;
}

/** Monaco tokenizer scope → highlight.js-style app token. */
export const MONACO_RULE_TOKEN_MAP: readonly MonacoRuleMapping[] = [
  { scope: '', token: '--t-code-text' },
  { scope: 'comment', token: '--t-hljs-comment', fontStyle: 'italic' },
  { scope: 'keyword', token: '--t-hljs-keyword' },
  { scope: 'string', token: '--t-hljs-string' },
  { scope: 'string.escape', token: '--t-hljs-symbol' },
  { scope: 'regexp', token: '--t-hljs-string' },
  { scope: 'number', token: '--t-hljs-number' },
  { scope: 'number.hex', token: '--t-hljs-number' },
  { scope: 'constant', token: '--t-hljs-symbol' },
  { scope: 'type', token: '--t-hljs-class' },
  { scope: 'type.identifier', token: '--t-hljs-class' },
  { scope: 'namespace', token: '--t-hljs-name' },
  { scope: 'delimiter', token: '--t-hljs-punctuation' },
  { scope: 'delimiter.bracket', token: '--t-hljs-punctuation' },
  { scope: 'operator', token: '--t-hljs-operator' },
  { scope: 'operators', token: '--t-hljs-operator' },
  { scope: 'tag', token: '--t-hljs-tag' },
  { scope: 'metatag', token: '--t-hljs-meta' },
  { scope: 'annotation', token: '--t-hljs-meta' },
  { scope: 'attribute.name', token: '--t-hljs-attr' },
  { scope: 'attribute.value', token: '--t-hljs-string' },
  { scope: 'key', token: '--t-hljs-attr' },
  { scope: 'string.key.json', token: '--t-hljs-attr' },
  { scope: 'string.value.json', token: '--t-hljs-string' },
  { scope: 'variable', token: '--t-hljs-params' },
  { scope: 'variable.predefined', token: '--t-hljs-property' },
  { scope: 'predefined', token: '--t-hljs-property' },
  { scope: 'function', token: '--t-hljs-function' },
  { scope: 'invalid', token: '--t-log-level-error' },
];

export interface DeriveMonacoThemeOptions {
  /** Tokens layered under `doc.tokens` (the mode built-in). */
  baseTokens?: Record<string, string>;
  /** Resolves CSS values this module cannot parse (renderer passes a DOM-backed resolver). */
  resolver?: ThemeColorResolver;
  /** When true, `editor.background` becomes fully transparent so a background image shows through. */
  transparentBackground?: boolean;
}

/**
 * Build a Monaco theme definition. Uses `doc.monaco` when present (with the transparent
 * background applied on top when requested); otherwise derives everything from tokens.
 */
export function deriveMonacoTheme(doc: ClaraThemeDocument, options: DeriveMonacoThemeOptions = {}): ThemeMonacoDefinition {
  const tokens: Record<string, string> = { ...(options.baseTokens ?? {}), ...doc.tokens };
  const resolve = (tokenName: string): string | null => resolveThemeTokenColor(tokens, tokenName, options.resolver);

  let def: ThemeMonacoDefinition;
  if (doc.monaco) {
    def = {
      base: doc.monaco.base,
      colors: { ...doc.monaco.colors },
      rules: doc.monaco.rules.map((r) => ({ ...r })),
    };
  } else {
    const colors: Record<string, string> = {};
    for (const m of MONACO_COLOR_TOKEN_MAP) {
      const hex = resolve(m.token);
      if (!hex) {
        continue;
      }
      colors[m.color] = m.alpha !== undefined ? hexWithAlpha(hex, m.alpha) : hex;
    }
    const rules: ThemeMonacoRule[] = [];
    for (const m of MONACO_RULE_TOKEN_MAP) {
      const hex = resolve(m.token);
      if (!hex) {
        continue;
      }
      const rule: ThemeMonacoRule = { token: m.scope, foreground: hex.slice(1, 7) };
      if (m.fontStyle) {
        rule.fontStyle = m.fontStyle;
      }
      rules.push(rule);
    }
    def = { base: doc.mode === 'light' ? 'vs' : 'vs-dark', colors, rules };
  }

  if (options.transparentBackground) {
    def.colors['editor.background'] = '#00000000';
    def.colors['editorGutter.background'] = '#00000000';
    def.colors['editorStickyScroll.background'] = '#00000000';
    def.colors['minimap.background'] = '#00000000';
  }
  return def;
}
