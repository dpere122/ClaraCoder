import { describe, expect, it } from 'vitest';
import { scopeThemeCss, scopeThemeSelector, splitCssTopLevel, stripCssComments } from './theme-css-scope';

const SCOPE = '[data-theme-group="chat.transcript"]';
/** Every style rule ends up inside the native `@scope` block. */
const wrap = (inner: string): string => `@scope (${SCOPE}) {\n${inner}\n}`;

describe('scopeThemeSelector', () => {
  // Inside `@scope`, a selector without `:scope`/`&` is implicitly relative to the root, so
  // anchoring on the group's attribute selector would never match; everything uses `:scope`.
  it('prefixes plain selectors as descendants of :scope', () => {
    expect(scopeThemeSelector('.msg-bubble', SCOPE)).toBe(':scope .msg-bubble');
    expect(scopeThemeSelector('> .x', SCOPE)).toBe(':scope > .x');
  });

  it('replaces root-like prefixes with :scope', () => {
    expect(scopeThemeSelector(':root', SCOPE)).toBe(':scope');
    expect(scopeThemeSelector('html .x', SCOPE)).toBe(':scope .x');
    expect(scopeThemeSelector('body', SCOPE)).toBe(':scope');
    expect(scopeThemeSelector('html body .x', SCOPE)).toBe(':scope .x');
    expect(scopeThemeSelector(':root > body > .x', SCOPE)).toBe(':scope > .x');
  });

  it('turns :host(<sel>) into :scope:is(<sel>)', () => {
    expect(scopeThemeSelector(':host(.open) .y', SCOPE)).toBe(':scope:is(.open) .y');
  });

  it('expands & to :scope', () => {
    expect(scopeThemeSelector('&.active > .x', SCOPE)).toBe(':scope.active > .x');
    expect(scopeThemeSelector('.dark &', SCOPE)).toBe('.dark :scope');
  });

  it('treats a copy of the group selector as the root', () => {
    expect(scopeThemeSelector(`${SCOPE} .msg`, SCOPE)).toBe(':scope .msg');
    expect(scopeThemeSelector(`${SCOPE}:hover`, SCOPE)).toBe(':scope:hover');
  });

  it('does not treat html-prefixed class names as the html element', () => {
    expect(scopeThemeSelector('.html-view', SCOPE)).toBe(':scope .html-view');
    expect(scopeThemeSelector('htmlarea', SCOPE)).toBe(':scope htmlarea');
    expect(scopeThemeSelector('body .html-view', SCOPE)).toBe(':scope .html-view');
  });
});

describe('splitCssTopLevel / stripCssComments', () => {
  it('splits on top-level commas only', () => {
    expect(splitCssTopLevel('a, b:is(c, d), "e,f"', ',')).toEqual(['a', ' b:is(c, d)', ' "e,f"']);
  });

  it('strips comments but keeps strings', () => {
    expect(stripCssComments('a { content: "/* keep */"; /* drop */ }')).toBe('a { content: "/* keep */";  }');
  });
});

describe('scopeThemeCss', () => {
  it('scopes every selector in a list, keeps declarations, and wraps in @scope', () => {
    const out = scopeThemeCss('.a, .b { color: red; background: blue }', SCOPE);
    expect(out.css).toBe(wrap(`:scope .a, :scope .b { color: red; background: blue; }`));
    expect(out.warnings).toEqual([]);
  });

  it('keeps conditional at-rules inside @scope and scopes their contents', () => {
    const out = scopeThemeCss('@media (max-width: 600px) { .a { color: red } }', SCOPE);
    expect(out.css).toBe(wrap(`@media (max-width: 600px) { :scope .a { color: red; } }`));
  });

  it('keeps keyframes verbatim, outside the @scope block', () => {
    const out = scopeThemeCss('@keyframes spin { from { opacity: 0 } to { opacity: 1 } }', SCOPE);
    expect(out.css).toBe('@keyframes spin { from { opacity: 0; } to { opacity: 1; } }');
  });

  it('hoists global at-rules out of @scope, preserving enclosing conditionals', () => {
    const out = scopeThemeCss('@media (prefers-reduced-motion: no-preference) { @keyframes spin { to { opacity: 1 } } .a { animation: spin 1s } }', SCOPE);
    expect(out.css).toBe(
      [
        '@media (prefers-reduced-motion: no-preference) { @keyframes spin { to { opacity: 1; } } }',
        wrap(`@media (prefers-reduced-motion: no-preference) { :scope .a { animation: spin 1s; } }`),
      ].join('\n'),
    );
  });

  it('drops @import, @scope, and unknown at-rules', () => {
    const out = scopeThemeCss(
      '@import url("https://evil.example/x.css"); @foo { .a { color: red } } @scope (body) { .z { color: red } } .b { color: blue }',
      SCOPE,
    );
    expect(out.css).toBe(wrap(`:scope .b { color: blue; }`));
    expect(out.warnings.length).toBe(3);
  });

  it('removes dangerous declarations and disallowed urls', () => {
    const out = scopeThemeCss(
      '.a { behavior: url(x.htc); color: red; background: url(https://evil.example/a.png); border-image: url("clara-theme://asset/t/a.png") }',
      SCOPE,
    );
    expect(out.css).toBe(wrap(`:scope .a { color: red; background: none; border-image: url("clara-theme://asset/t/a.png"); }`));
    expect(out.warnings.some((w) => w.includes('unsafe'))).toBe(true);
    expect(out.warnings.some((w) => w.includes('disallowed scheme'))).toBe(true);
  });

  it('tokenizes quoted url() arguments so a ")" inside the string cannot hide a remote url', () => {
    const out = scopeThemeCss('.a { background: url("https://evil.example/a)b.png") }', SCOPE);
    expect(out.css).toBe(wrap(`:scope .a { background: none; }`));
    expect(out.warnings.some((w) => w.includes('disallowed scheme'))).toBe(true);
  });

  it('checks src() and image-set() string arguments', () => {
    const out = scopeThemeCss(
      '.a { background: image-set("https://evil.example/x.png" 1x); mask: src("data:image/png;base64,AAAA"); content: image-set(url(https://evil.example/y.png) 1x) }',
      SCOPE,
    );
    expect(out.css).toBe(wrap(`:scope .a { background: none; mask: src("data:image/png;base64,AAAA"); content: image-set(none 1x); }`));
  });

  it('drops declarations that use CSS escapes outside strings (no u\\72l( tricks)', () => {
    const out = scopeThemeCss('.a { background: u\\72l(https://evil.example/a.png); color: red }', SCOPE);
    expect(out.css).toBe(wrap(`:scope .a { color: red; }`));
    expect(out.warnings.some((w) => w.includes('escape outside a string'))).toBe(true);
  });

  it('drops selectors that can only target siblings of the group root', () => {
    const out = scopeThemeCss('& ~ * { display: none } + .sidebar { display: none } ~ .x, .keep { color: red }', SCOPE);
    expect(out.css).toBe(wrap(`:scope .keep { color: red; }`));
    expect(out.warnings.length).toBe(3);
    expect(out.warnings[0]).toMatch(/siblings of the group root/);
  });

  it('keeps pseudo-class uses of & (contained by @scope) and nested rules', () => {
    const out = scopeThemeCss(':not(&) { margin: 0 } .a { color: red; &:hover { color: blue } }', SCOPE);
    expect(out.css).toBe(wrap(`:not(:scope) { margin: 0; }\n:scope .a { color: red; &:hover { color: blue; } }`));
  });

  it('survives unbalanced input without throwing', () => {
    const out = scopeThemeCss('.a { color: red', SCOPE);
    expect(out.css).toBe('');
    expect(out.warnings.length).toBeGreaterThan(0);
  });

  it('truncates oversized css', () => {
    const big = `.a { color: red }`.repeat(3000);
    const out = scopeThemeCss(big, SCOPE);
    expect(out.warnings[0]).toMatch(/truncated/);
  });
});
