import { describe, expect, it } from 'vitest';
import { CLARA_DARK_THEME, CLARA_LIGHT_THEME } from './builtin';
import { cssColorToHex, deriveMonacoTheme, hexWithAlpha, resolveThemeTokenColor } from './theme-monaco';

describe('cssColorToHex', () => {
  it('parses hex forms', () => {
    expect(cssColorToHex('#abc')).toBe('#aabbcc');
    expect(cssColorToHex('#AABBCC')).toBe('#aabbcc');
    expect(cssColorToHex('#aabbccff')).toBe('#aabbcc');
    expect(cssColorToHex('#aabbcc80')).toBe('#aabbcc80');
    expect(cssColorToHex('#xyz')).toBeNull();
  });

  it('parses rgb / rgba / hsl / color(srgb)', () => {
    expect(cssColorToHex('rgb(168, 184, 154)')).toBe('#a8b89a');
    expect(cssColorToHex('rgba(168, 184, 154, 0.5)')).toBe('#a8b89a80');
    expect(cssColorToHex('rgb(100% 0% 0% / 50%)')).toBe('#ff000080');
    expect(cssColorToHex('hsl(0, 100%, 50%)')).toBe('#ff0000');
    expect(cssColorToHex('hsl(120 100% 25%)')).toBe('#008000');
    expect(cssColorToHex('color(srgb 1 0 0 / 0.5)')).toBe('#ff000080');
    expect(cssColorToHex('transparent')).toBe('#00000000');
    expect(cssColorToHex('color-mix(in srgb, red, blue)')).toBeNull();
  });

  it('hexWithAlpha multiplies existing alpha', () => {
    expect(hexWithAlpha('#ff0000', 0.5)).toBe('#ff000080');
    expect(hexWithAlpha('#ff000080', 0.5)).toBe('#ff000040');
  });
});

describe('resolveThemeTokenColor', () => {
  it('follows var() chains and uses the resolver for unparseable values', () => {
    const tokens = {
      '--t-a': 'var(--t-b)',
      '--t-b': '#112233',
      '--t-mix': 'color-mix(in srgb, red, blue)',
      '--t-loop': 'var(--t-loop)',
    };
    expect(resolveThemeTokenColor(tokens, '--t-a')).toBe('#112233');
    expect(resolveThemeTokenColor(tokens, '--t-mix')).toBeNull();
    expect(resolveThemeTokenColor(tokens, '--t-mix', () => '#00ff00')).toBe('#00ff00');
    expect(resolveThemeTokenColor(tokens, '--t-loop')).toBeNull();
    expect(resolveThemeTokenColor(tokens, '--t-missing')).toBeNull();
  });
});

describe('deriveMonacoTheme', () => {
  it('derives a full palette from the dark built-in', () => {
    const def = deriveMonacoTheme(CLARA_DARK_THEME);
    expect(def.base).toBe('vs-dark');
    expect(def.colors['editor.background']).toBe('#151812');
    expect(def.colors['editor.foreground']).toBe('#ddd8cc');
    expect(def.colors['editor.selectionBackground']).toBe('#a8b89a47');
    expect(def.rules.find((r) => r.token === 'comment')).toEqual({ token: 'comment', foreground: '6b7361', fontStyle: 'italic' });
  });

  it('uses vs for light themes and honours transparentBackground', () => {
    const def = deriveMonacoTheme(CLARA_LIGHT_THEME, { transparentBackground: true });
    expect(def.base).toBe('vs');
    expect(def.colors['editor.background']).toBe('#00000000');
    expect(def.colors['editor.foreground']).toBe('#3d2b1f');
  });

  it('prefers an explicit monaco block', () => {
    const def = deriveMonacoTheme({
      ...CLARA_DARK_THEME,
      monaco: { base: 'hc-black', colors: { 'editor.background': '#000000' }, rules: [{ token: 'keyword', foreground: 'ff00ff' }] },
    });
    expect(def.base).toBe('hc-black');
    expect(def.colors).toEqual({ 'editor.background': '#000000' });
    expect(def.rules).toEqual([{ token: 'keyword', foreground: 'ff00ff' }]);
  });
});
