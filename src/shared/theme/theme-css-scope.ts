/**
 * Sanitize and scope a theme group's "Advanced CSS" so it can only style descendants of
 * that group's root element and cannot pull remote resources or run legacy script hooks.
 *
 * String-based (no DOM) so Electron main can validate on import/save and the renderer can
 * apply the same output. Output is fed to the browser's CSS parser afterwards, which drops
 * anything still malformed.
 *
 * Author conventions:
 * - Plain selectors become descendants: `.msg-bubble` → `[data-theme-group="g"] .msg-bubble`.
 * - `&`, `:host`, `:scope`, `:root`, `html`, `body` at the start of a selector target the group root.
 * - `@media`, `@supports`, `@container`, `@layer` blocks are kept and their contents scoped.
 * - `@keyframes`, `@font-face`, `@page`, `@property`, `@counter-style` are kept verbatim.
 * - `@import` / unknown at-rules, `expression()`, `behavior:`, `-moz-binding`, `javascript:` and
 *   `url()` values outside `clara-theme:` / `data:image/` / `data:font/` are removed.
 */

export interface ThemeCssScopeResult {
  css: string;
  warnings: string[];
}

export const THEME_GROUP_CSS_MAX_CHARS = 20_000;

const CONDITIONAL_AT_RULES = new Set(['media', 'supports', 'container', 'layer', 'scope']);
const VERBATIM_AT_RULES = new Set([
  'keyframes',
  '-webkit-keyframes',
  'font-face',
  'page',
  'property',
  'counter-style',
  'font-feature-values',
]);
const ROOT_SELECTOR_PREFIX = /^(:root|:host|:scope|html|body)(?![\w-])/;
const DANGEROUS_DECLARATION = /(expression\s*\(|behavior\s*:|-moz-binding|javascript\s*:|@import|<\/?\s*style|vbscript\s*:)/i;
const URL_FUNCTION = /url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/gi;
const ALLOWED_URL_PREFIXES = ['clara-theme:', 'data:image/', 'data:font/'];

export function isAllowedThemeCssUrl(url: string): boolean {
  const u = url.trim().toLowerCase();
  if (!u) {
    return false;
  }
  return ALLOWED_URL_PREFIXES.some((prefix) => u.indexOf(prefix) === 0);
}

function isQuote(ch: string): boolean {
  return ch === '"' || ch === "'";
}

/** Index just past the closing quote that matches the quote at `start`. */
function skipString(src: string, start: number): number {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) {
      return i + 1;
    }
    i++;
  }
  return src.length;
}

/** Remove `/* … *\/` comments outside of strings. */
export function stripCssComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (isQuote(ch)) {
      const end = skipString(src, i);
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      i = close < 0 ? src.length : close + 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Index of the first occurrence of one of `targets` at nesting depth 0 (parens, brackets,
 * and braces balanced; strings skipped), or -1.
 */
function findTopLevel(src: string, from: number, targets: string): number {
  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let i = from;
  while (i < src.length) {
    const ch = src[i]!;
    if (isQuote(ch)) {
      i = skipString(src, i);
      continue;
    }
    if (depthParen === 0 && depthBracket === 0 && depthBrace === 0 && targets.indexOf(ch) >= 0) {
      return i;
    }
    if (ch === '(') depthParen++;
    else if (ch === ')') depthParen = Math.max(0, depthParen - 1);
    else if (ch === '[') depthBracket++;
    else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);
    else if (ch === '{') depthBrace++;
    else if (ch === '}') depthBrace = Math.max(0, depthBrace - 1);
    i++;
  }
  return -1;
}

/** Index of the `}` matching the `{` at `openIdx`, or -1 when unbalanced. */
function findMatchingBrace(src: string, openIdx: number): number {
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const ch = src[i]!;
    if (isQuote(ch)) {
      i = skipString(src, i);
      continue;
    }
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
    i++;
  }
  return -1;
}

/** Split on `sep` at depth 0 (parens/brackets balanced, strings skipped). */
export function splitCssTopLevel(src: string, sep: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let i = 0;
  while (i < src.length) {
    const idx = findTopLevel(src, i, sep);
    if (idx < 0) {
      break;
    }
    parts.push(src.slice(start, idx));
    start = idx + 1;
    i = start;
  }
  parts.push(src.slice(start));
  return parts;
}

function sanitizeUrls(decl: string, warnings: string[]): string | null {
  let blocked = false;
  const rewritten = decl.replace(URL_FUNCTION, (whole, _q: string, target: string) => {
    if (isAllowedThemeCssUrl(target)) {
      return whole;
    }
    blocked = true;
    return 'none';
  });
  if (blocked) {
    warnings.push(`Removed url() with a disallowed scheme in "${decl.trim().slice(0, 60)}"`);
  }
  return rewritten;
}

function sanitizeDeclaration(decl: string, warnings: string[]): string | null {
  const trimmed = decl.trim();
  if (!trimmed) {
    return null;
  }
  if (DANGEROUS_DECLARATION.test(trimmed)) {
    warnings.push(`Removed unsafe declaration "${trimmed.slice(0, 60)}"`);
    return null;
  }
  return sanitizeUrls(trimmed, warnings);
}

/**
 * Body of a style rule: declarations plus (optionally) nested rules. Nested rules keep
 * their prelude verbatim because the enclosing selector is already scoped.
 */
function processRuleBody(body: string, warnings: string[]): string {
  const decls: string[] = [];
  const nested: string[] = [];
  let i = 0;
  while (i < body.length) {
    const stop = findTopLevel(body, i, ';{');
    if (stop < 0) {
      const decl = sanitizeDeclaration(body.slice(i), warnings);
      if (decl) decls.push(decl);
      break;
    }
    if (body[stop] === ';') {
      const decl = sanitizeDeclaration(body.slice(i, stop), warnings);
      if (decl) decls.push(decl);
      i = stop + 1;
      continue;
    }
    const close = findMatchingBrace(body, stop);
    if (close < 0) {
      warnings.push('Dropped unbalanced nested block');
      break;
    }
    const prelude = body.slice(i, stop).trim();
    const inner = processRuleBody(body.slice(stop + 1, close), warnings);
    if (prelude && inner) {
      nested.push(`${prelude} { ${inner} }`);
    }
    i = close + 1;
  }
  const parts: string[] = [];
  if (decls.length > 0) {
    parts.push(`${decls.join('; ')};`);
  }
  for (const block of nested) {
    parts.push(block);
  }
  return parts.join(' ');
}

export function scopeThemeSelector(selector: string, scope: string): string {
  const s = selector.trim();
  if (!s) {
    return '';
  }
  if (s.indexOf('&') >= 0) {
    return s.split('&').join(scope);
  }
  const m = ROOT_SELECTOR_PREFIX.exec(s);
  if (m) {
    return scope + s.slice(m[0].length);
  }
  return `${scope} ${s}`;
}

function processBlock(src: string, scope: string, warnings: string[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const stop = findTopLevel(src, i, '{;');
    if (stop < 0) {
      const leftover = src.slice(i).trim();
      if (leftover) {
        warnings.push(`Dropped trailing text "${leftover.slice(0, 40)}"`);
      }
      break;
    }
    const prelude = src.slice(i, stop).trim();
    if (src[stop] === ';') {
      if (prelude) {
        warnings.push(`Dropped statement "${prelude.slice(0, 40)}"`);
      }
      i = stop + 1;
      continue;
    }
    const close = findMatchingBrace(src, stop);
    if (close < 0) {
      warnings.push('Dropped unbalanced block');
      break;
    }
    const body = src.slice(stop + 1, close);
    i = close + 1;
    if (!prelude) {
      continue;
    }
    if (prelude.charAt(0) === '@') {
      const nameMatch = /^@([a-zA-Z-]+)/.exec(prelude);
      const name = nameMatch ? nameMatch[1]!.toLowerCase() : '';
      if (CONDITIONAL_AT_RULES.has(name)) {
        const inner = processBlock(body, scope, warnings);
        if (inner) {
          out.push(`${prelude} { ${inner} }`);
        }
        continue;
      }
      if (VERBATIM_AT_RULES.has(name)) {
        const inner = processRuleBody(body, warnings);
        if (inner) {
          out.push(`${prelude} { ${inner} }`);
        }
        continue;
      }
      warnings.push(`Dropped unsupported at-rule "${prelude.slice(0, 40)}"`);
      continue;
    }
    const selectors = splitCssTopLevel(prelude, ',')
      .map((sel) => scopeThemeSelector(sel, scope))
      .filter((sel) => sel.length > 0);
    const inner = processRuleBody(body, warnings);
    if (selectors.length > 0 && inner) {
      out.push(`${selectors.join(', ')} { ${inner} }`);
    }
  }
  return out.join('\n');
}

/**
 * Sanitize `css` and scope every selector under `scope` (a CSS selector such as
 * `[data-theme-group="chat.transcript"]`). Never throws.
 */
export function scopeThemeCss(css: string, scope: string): ThemeCssScopeResult {
  const warnings: string[] = [];
  let source = typeof css === 'string' ? css : '';
  if (source.length > THEME_GROUP_CSS_MAX_CHARS) {
    warnings.push(`CSS truncated to ${THEME_GROUP_CSS_MAX_CHARS} characters`);
    source = source.slice(0, THEME_GROUP_CSS_MAX_CHARS);
  }
  const cleaned = stripCssComments(source);
  const result = processBlock(cleaned, scope, warnings);
  return { css: result.trim(), warnings };
}
