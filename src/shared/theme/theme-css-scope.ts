/**
 * Sanitize and scope a theme group's "Advanced CSS" so it can only style descendants of
 * that group's root element and cannot pull remote resources or run legacy script hooks.
 *
 * String-based (no DOM) so Electron main can validate on import/save and the renderer can
 * apply the same output. Output is fed to the browser's CSS parser afterwards, which drops
 * anything still malformed.
 *
 * Containment has two layers:
 * 1. Every style rule is wrapped in a native `@scope (<group root>) { … }` block. The browser
 *    then only matches subjects inside the group root, no matter how the selector is written
 *    (`:not(&)`, `:is(&, body)`, `html:has(&) *`, sibling combinators, … all stay contained).
 * 2. Selectors are additionally prefixed (`.msg-bubble` → `[data-theme-group="g"] .msg-bubble`)
 *    so specificity matches component CSS, and selectors that can only ever target a
 *    *sibling* of the root (`& ~ .x`, `+ .x`) are dropped with a warning because they can
 *    never match anything in scope.
 *
 * Author conventions:
 * - Plain selectors become descendants: `.msg-bubble` → `[data-theme-group="g"] .msg-bubble`.
 * - `&`, `:host`, `:scope`, `:root`, `html`, `body` at the start of a selector target the group root.
 * - `@media`, `@supports`, `@container`, `@layer` blocks are kept and their contents scoped.
 * - `@keyframes`, `@font-face`, `@page`, `@property`, `@counter-style` are kept verbatim and
 *   hoisted outside the `@scope` block (they are global by nature).
 * - `@import` / `@scope` / unknown at-rules, `expression()`, `behavior:`, `-moz-binding`,
 *   `javascript:`, CSS escapes outside strings, and `url()` / `src()` / `image-set()` values
 *   outside `clara-theme:` / `data:image/` / `data:font/` are removed.
 */

export interface ThemeCssScopeResult {
  css: string;
  warnings: string[];
}

export const THEME_GROUP_CSS_MAX_CHARS = 20_000;

const CONDITIONAL_AT_RULES = new Set(['media', 'supports', 'container', 'layer']);
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
/** Functions whose arguments load a resource. */
const URL_FUNCTIONS = new Set(['url', 'src', 'image', 'image-set', '-webkit-image-set']);
const ALLOWED_URL_PREFIXES = ['clara-theme:', 'data:image/', 'data:font/'];
const IDENT_CHAR = /[A-Za-z0-9_-]/;

export function isAllowedThemeCssUrl(url: string): boolean {
  const u = url.trim().toLowerCase();
  if (!u || u.indexOf('\\') >= 0) {
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

/** Index of the `)` matching the `(` at `openIdx` (strings skipped), or -1 when unbalanced. */
function findMatchingParen(src: string, openIdx: number): number {
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const ch = src[i]!;
    if (isQuote(ch)) {
      i = skipString(src, i);
      continue;
    }
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
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

/** Raw bodies of every quoted string in `src` (quotes stripped, escapes left as-is). */
function quotedStrings(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    if (isQuote(src[i]!)) {
      const end = skipString(src, i);
      const closed = end <= src.length && src[end - 1] === src[i] && end - 1 > i;
      out.push(src.slice(i + 1, closed ? end - 1 : end));
      i = end;
      continue;
    }
    i++;
  }
  return out;
}

/** The single URL argument of `url( … )`: quoted body or the trimmed unquoted text. */
function urlArgument(inner: string): string {
  const trimmed = inner.trim();
  if (trimmed && isQuote(trimmed.charAt(0))) {
    return quotedStrings(trimmed)[0] ?? trimmed;
  }
  return trimmed;
}

interface UrlSpan {
  start: number;
  end: number;
  blocked: boolean;
}

interface UrlScan {
  spans: UrlSpan[];
  escapeOutsideString: boolean;
}

/**
 * Locate every resource-loading function call in a declaration and decide whether its
 * argument(s) are allowed. Quoted strings are tokenized properly, so `url("a)b")` and
 * `image-set("…" 1x)` are both understood.
 */
function scanUrlFunctions(decl: string): UrlScan {
  const spans: UrlSpan[] = [];
  let escapeOutsideString = false;
  let i = 0;
  while (i < decl.length) {
    const ch = decl[i]!;
    if (isQuote(ch)) {
      i = skipString(decl, i);
      continue;
    }
    if (ch === '\\') {
      escapeOutsideString = true;
      i += 2;
      continue;
    }
    if (ch === '(') {
      let j = i - 1;
      while (j >= 0 && IDENT_CHAR.test(decl[j]!)) {
        j--;
      }
      const name = decl.slice(j + 1, i).toLowerCase();
      if (URL_FUNCTIONS.has(name)) {
        const close = findMatchingParen(decl, i);
        const end = close < 0 ? decl.length : close + 1;
        const inner = decl.slice(i + 1, close < 0 ? decl.length : close);
        let blocked: boolean;
        if (name === 'url') {
          blocked = !isAllowedThemeCssUrl(urlArgument(inner));
        } else {
          // `src()` / `image-set()` take strings (or nested url(), handled by the outer scan).
          blocked = /var\s*\(/i.test(inner) || quotedStrings(inner).some((s) => !isAllowedThemeCssUrl(s));
        }
        spans.push({ start: j + 1, end, blocked });
        if (name === 'url') {
          i = end;
          continue;
        }
      }
    }
    i++;
  }
  return { spans, escapeOutsideString };
}

function sanitizeUrls(decl: string, warnings: string[]): string | null {
  const { spans, escapeOutsideString } = scanUrlFunctions(decl);
  if (escapeOutsideString) {
    warnings.push(`Removed declaration with a CSS escape outside a string "${decl.trim().slice(0, 60)}"`);
    return null;
  }
  const blocked = spans.filter((s) => s.blocked);
  if (blocked.length === 0) {
    return decl;
  }
  let out = '';
  let cursor = 0;
  for (const span of blocked) {
    if (span.start < cursor) {
      // Nested inside a span that was already replaced.
      continue;
    }
    out += decl.slice(cursor, span.start) + 'none';
    cursor = span.end;
  }
  out += decl.slice(cursor);
  warnings.push(`Removed url() with a disallowed scheme in "${decl.trim().slice(0, 60)}"`);
  return out;
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
 * their prelude verbatim; the enclosing `@scope` block keeps them contained.
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

/**
 * True when a scoped selector starts at the group root and immediately steps to a sibling
 * (`[scope] ~ .x`, `[scope] + .x`). Such subjects are never inside the root, so the rule could
 * not match under `@scope`; dropping it with a warning is more useful than silence.
 */
function targetsRootSibling(scopedSelector: string, scope: string): boolean {
  if (scopedSelector.indexOf(scope) !== 0) {
    return false;
  }
  const rest = scopedSelector.slice(scope.length).trim();
  return rest.charAt(0) === '~' || rest.charAt(0) === '+';
}

function wrapInConditionals(rule: string, wrap: readonly string[]): string {
  let out = rule;
  for (let i = wrap.length - 1; i >= 0; i--) {
    out = `${wrap[i]} { ${out} }`;
  }
  return out;
}

/**
 * Walk a block of rules. Returns the scoped rules (to be placed inside `@scope`); verbatim
 * at-rules are appended to `global` (wrapped in any enclosing conditional preludes).
 */
function processBlock(src: string, scope: string, warnings: string[], global: string[], wrap: readonly string[]): string[] {
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
        const inner = processBlock(body, scope, warnings, global, [...wrap, prelude]);
        if (inner.length > 0) {
          out.push(`${prelude} { ${inner.join(' ')} }`);
        }
        continue;
      }
      if (VERBATIM_AT_RULES.has(name)) {
        const inner = processRuleBody(body, warnings);
        if (inner) {
          global.push(wrapInConditionals(`${prelude} { ${inner} }`, wrap));
        }
        continue;
      }
      warnings.push(`Dropped unsupported at-rule "${prelude.slice(0, 40)}"`);
      continue;
    }
    const selectors: string[] = [];
    for (const raw of splitCssTopLevel(prelude, ',')) {
      const scoped = scopeThemeSelector(raw, scope);
      if (!scoped) {
        continue;
      }
      if (targetsRootSibling(scoped, scope)) {
        warnings.push(`Dropped selector "${raw.trim().slice(0, 40)}": siblings of the group root are outside the group`);
        continue;
      }
      selectors.push(scoped);
    }
    const inner = processRuleBody(body, warnings);
    if (selectors.length > 0 && inner) {
      out.push(`${selectors.join(', ')} { ${inner} }`);
    }
  }
  return out;
}

/**
 * Sanitize `css` and scope every selector under `scope` (a CSS selector such as
 * `[data-theme-group="chat.transcript"]`). Style rules are emitted inside a native
 * `@scope (scope) { … }` block; global at-rules (`@keyframes`, `@font-face`, …) precede it.
 * Never throws.
 */
export function scopeThemeCss(css: string, scope: string): ThemeCssScopeResult {
  const warnings: string[] = [];
  let source = typeof css === 'string' ? css : '';
  if (source.length > THEME_GROUP_CSS_MAX_CHARS) {
    warnings.push(`CSS truncated to ${THEME_GROUP_CSS_MAX_CHARS} characters`);
    source = source.slice(0, THEME_GROUP_CSS_MAX_CHARS);
  }
  const cleaned = stripCssComments(source);
  const global: string[] = [];
  const scoped = processBlock(cleaned, scope, warnings, global, []);
  const parts = [...global];
  if (scoped.length > 0) {
    parts.push(`@scope (${scope}) {\n${scoped.join('\n')}\n}`);
  }
  return { css: parts.join('\n').trim(), warnings };
}
