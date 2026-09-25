import { describe, expect, it } from 'vitest';
import { CLARA_DARK_THEME, CLARA_LIGHT_THEME } from './builtin';
import {
  isSafeThemeTokenValue,
  missingThemeTokens,
  normalizeMonacoHex,
  slugifyThemeId,
  themeBackgroundGroupIds,
  validateThemeDocument,
} from './theme-document';
import { THEME_TOKENS } from './theme-tokens';

describe('validateThemeDocument', () => {
  it('accepts the built-in themes without warnings about tokens', () => {
    for (const builtIn of [CLARA_DARK_THEME, CLARA_LIGHT_THEME]) {
      const result = validateThemeDocument(builtIn);
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.warnings.filter((w) => w.path.indexOf('tokens') === 0)).toEqual([]);
      expect(missingThemeTokens(result.doc!)).toEqual([]);
    }
  });

  it('built-ins define every catalog token', () => {
    for (const builtIn of [CLARA_DARK_THEME, CLARA_LIGHT_THEME]) {
      for (const token of THEME_TOKENS) {
        expect(builtIn.tokens[token.name], `${builtIn.id} ${token.name}`).toBeTruthy();
      }
    }
  });

  it('rejects non-objects and bad versions', () => {
    expect(validateThemeDocument(null).ok).toBe(false);
    expect(validateThemeDocument('x').ok).toBe(false);
    const bad = validateThemeDocument({ version: 2, id: 'x-y', name: 'X', mode: 'dark' });
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]!.path).toBe('version');
  });

  it('derives id from name and assumes dark mode when missing', () => {
    const result = validateThemeDocument({ name: 'My Neon Theme!' });
    expect(result.ok).toBe(true);
    expect(result.doc!.id).toBe('my-neon-theme');
    expect(result.doc!.mode).toBe('dark');
    expect(result.warnings.some((w) => w.path === 'id')).toBe(true);
  });

  it('drops unknown tokens, unsafe values, and unknown groups with warnings', () => {
    const result = validateThemeDocument({
      id: 'neon',
      name: 'Neon',
      mode: 'dark',
      tokens: {
        '--t-primary': '#ff00ff',
        '--t-nope': '#000',
        '--t-secondary': 'red; } body { display:none',
      },
      groups: {
        'chat.transcript': { tokens: { '--t-bg': '#101010' }, css: '.a { color: red }' },
        'nope.group': { css: '.x{}' },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.doc!.tokens).toEqual({ '--t-primary': '#ff00ff' });
    expect(Object.keys(result.doc!.groups)).toEqual(['chat.transcript']);
    expect(result.warnings.map((w) => w.path)).toEqual(
      expect.arrayContaining(['tokens.--t-nope', 'tokens.--t-secondary', 'groups.nope.group']),
    );
  });

  it('normalizes background overlays and flags missing assets', () => {
    const result = validateThemeDocument({
      id: 'bg',
      name: 'Bg',
      mode: 'dark',
      assets: { wall: 'wall.png', bad: '../etc/passwd' },
      groups: {
        'chat.transcript': { background: { enabled: true, asset: 'wall', opacity: 40, fit: 'tile' } },
        'editor.monaco': { background: { enabled: true, asset: 'missing', opacity: 0.5, fit: 'weird' } },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.doc!.assets).toEqual({ wall: 'wall.png' });
    expect(result.doc!.groups['chat.transcript']!.background).toEqual({
      enabled: true,
      asset: 'wall',
      opacity: 0.4,
      fit: 'tile',
    });
    expect(result.doc!.groups['editor.monaco']!.background!.fit).toBe('cover');
    expect(result.warnings.some((w) => w.message.includes('missing asset'))).toBe(true);
    expect(themeBackgroundGroupIds(result.doc!)).toEqual(['chat.transcript']);
  });

  it('accepts embedded data: image assets and rejects other schemes', () => {
    const result = validateThemeDocument({
      id: 'bg',
      name: 'Bg',
      mode: 'light',
      assets: { a: 'data:image/png;base64,AAAA', b: 'https://x/y.png', c: 'data:text/html,hi' },
    });
    expect(result.doc!.assets).toEqual({ a: 'data:image/png;base64,AAAA' });
  });

  it('normalizes monaco colors and rules', () => {
    const result = validateThemeDocument({
      id: 'm',
      name: 'M',
      mode: 'dark',
      monaco: {
        base: 'hc-black',
        colors: { 'editor.background': '#123', 'bad key!': '#000000', 'editor.foreground': 'red' },
        rules: [{ token: 'comment', foreground: '#AABBCC', fontStyle: 'italic' }, { token: 'bad token!' }, 'x'],
      },
    });
    expect(result.doc!.monaco).toEqual({
      base: 'hc-black',
      colors: { 'editor.background': '#112233' },
      rules: [{ token: 'comment', foreground: 'aabbcc', fontStyle: 'italic' }],
    });
  });
});

describe('helpers', () => {
  it('isSafeThemeTokenValue blocks injection characters', () => {
    expect(isSafeThemeTokenValue('#fff')).toBe(true);
    expect(isSafeThemeTokenValue('color-mix(in srgb, var(--t-bg) 50%, red)')).toBe(true);
    expect(isSafeThemeTokenValue('red; background: url(x)')).toBe(false);
    expect(isSafeThemeTokenValue('url(https://x)')).toBe(false);
    expect(isSafeThemeTokenValue('')).toBe(false);
  });

  it('slugifyThemeId and normalizeMonacoHex', () => {
    expect(slugifyThemeId('  Hello World 2 ')).toBe('hello-world-2');
    expect(slugifyThemeId('!!!')).toBe('custom-theme');
    expect(normalizeMonacoHex('#abc')).toBe('#aabbcc');
    expect(normalizeMonacoHex('#AABBCCDD')).toBe('#aabbccdd');
    expect(normalizeMonacoHex('blue')).toBeNull();
  });
});
