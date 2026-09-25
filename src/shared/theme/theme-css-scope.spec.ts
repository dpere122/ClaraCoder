import { describe, expect, it } from 'vitest';
import { scopeThemeCss, scopeThemeSelector, splitCssTopLevel, stripCssComments } from './theme-css-scope';

const SCOPE = '[data-theme-group="chat.transcript"]';

describe('scopeThemeSelector', () => {
  it('prefixes plain selectors as descendants', () => {
    expect(scopeThemeSelector('.msg-bubble', SCOPE)).toBe(`${SCOPE} .msg-bubble`);
  });

  it('replaces root-like prefixes with the scope', () => {
    expect(scopeThemeSelector(':root', SCOPE)).toBe(SCOPE);
    expect(scopeThemeSelector('html .x', SCOPE)).toBe(`${SCOPE} .x`);
    expect(scopeThemeSelector(':host(.open) .y', SCOPE)).toBe(`${SCOPE}(.open) .y`);
    expect(scopeThemeSelector('body', SCOPE)).toBe(SCOPE);
  });

  it('expands & to the scope', () => {
    expect(scopeThemeSelector('&.active > .x', SCOPE)).toBe(`${SCOPE}.active > .x`);
  });

  it('does not treat html-prefixed class names as the html element', () => {
    expect(scopeThemeSelector('.html-view', SCOPE)).toBe(`${SCOPE} .html-view`);
    expect(scopeThemeSelector('htmlarea', SCOPE)).toBe(`${SCOPE} htmlarea`);
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
  it('scopes every selector in a list and keeps declarations', () => {
    const out = scopeThemeCss('.a, .b { color: red; background: blue }', SCOPE);
    expect(out.css).toBe(`${SCOPE} .a, ${SCOPE} .b { color: red; background: blue; }`);
    expect(out.warnings).toEqual([]);
  });

  it('keeps conditional at-rules and scopes their contents', () => {
    const out = scopeThemeCss('@media (max-width: 600px) { .a { color: red } }', SCOPE);
    expect(out.css).toBe(`@media (max-width: 600px) { ${SCOPE} .a { color: red; } }`);
  });

  it('keeps keyframes verbatim', () => {
    const out = scopeThemeCss('@keyframes spin { from { opacity: 0 } to { opacity: 1 } }', SCOPE);
    expect(out.css).toBe('@keyframes spin { from { opacity: 0; } to { opacity: 1; } }');
  });

  it('drops @import and unknown at-rules', () => {
    const out = scopeThemeCss('@import url("https://evil.example/x.css"); @foo { .a { color: red } } .b { color: blue }', SCOPE);
    expect(out.css).toBe(`${SCOPE} .b { color: blue; }`);
    expect(out.warnings.length).toBe(2);
  });

  it('removes dangerous declarations and disallowed urls', () => {
    const out = scopeThemeCss(
      '.a { behavior: url(x.htc); color: red; background: url(https://evil.example/a.png); border-image: url("clara-theme://asset/t/a.png") }',
      SCOPE,
    );
    expect(out.css).toBe(
      `${SCOPE} .a { color: red; background: none; border-image: url("clara-theme://asset/t/a.png"); }`,
    );
    expect(out.warnings.some((w) => w.includes('unsafe'))).toBe(true);
    expect(out.warnings.some((w) => w.includes('disallowed scheme'))).toBe(true);
  });

  it('keeps nested rules inside a scoped rule', () => {
    const out = scopeThemeCss('.a { color: red; &:hover { color: blue } }', SCOPE);
    expect(out.css).toBe(`${SCOPE} .a { color: red; &:hover { color: blue; } }`);
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
