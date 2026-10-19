import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME } from './builtin';
import type { ClaraThemeDocument } from './theme-document';
import { cssQuote, resolveThemeDocument, themeStylesheetText } from './theme-resolve';

const custom: ClaraThemeDocument = {
  version: 1,
  id: 'neon',
  name: 'Neon',
  mode: 'dark',
  tokens: { '--t-primary': '#ff00ff' },
  groups: {
    'chat.transcript': {
      tokens: { '--t-bg': '#101010' },
      css: '.msg-bubble { border-radius: 0 }',
      background: { enabled: true, asset: 'wall', opacity: 0.4, fit: 'cover' },
    },
    'chat.composer': {
      background: { enabled: true, asset: 'wall', opacity: 0.4, fit: 'cover' },
    },
  },
  assets: { wall: 'wall.png' },
};

describe('resolveThemeDocument', () => {
  it('layers theme tokens over the mode built-in', () => {
    const resolved = resolveThemeDocument(custom);
    expect(resolved.tokens['--t-primary']).toBe('#ff00ff');
    expect(resolved.tokens['--t-bg']).toBe(DEFAULT_THEME.tokens['--t-bg']);
    expect(Object.keys(resolved.tokens).length).toBe(Object.keys(DEFAULT_THEME.tokens).length);
  });

  it('only resolves backgrounds for groups that support them', () => {
    const resolved = resolveThemeDocument(custom);
    const transcript = resolved.groups.find((g) => g.id === 'chat.transcript')!;
    expect(transcript.background).toEqual({
      asset: 'wall',
      assetValue: 'wall.png',
      opacity: 0.4,
      fit: 'cover',
      clearSelectors: ['.chat-box'],
    });
    expect(transcript.css).toContain('[data-theme-group="chat.transcript"] .msg-bubble');
    expect(resolved.groups.find((g) => g.id === 'chat.composer')).toBeUndefined();
  });

  it('emits stylesheet text with root tokens, group tokens, and overlay rules', () => {
    const resolved = resolveThemeDocument(custom);
    const { tokensCss, groupsCss } = themeStylesheetText(resolved, (themeId, asset, value) => `clara-theme://asset/${themeId}/${value}`);
    expect(tokensCss).toContain(':root {');
    expect(tokensCss).toContain('  --t-primary: #ff00ff;');
    expect(tokensCss).toContain('[data-theme-group="chat.transcript"] {\n  --t-bg: #101010;\n}');
    expect(tokensCss).toContain('background-image: url("clara-theme://asset/neon/wall.png");');
    expect(tokensCss).toContain('opacity: 0.4;');
    expect(tokensCss).toContain('[data-theme-group="chat.transcript"] .chat-box {\n  background-color: transparent !important;');
    expect(groupsCss).toContain('/* chat.transcript */');
  });

  it('skips overlay rules when the asset resolver returns null', () => {
    const resolved = resolveThemeDocument(custom);
    const { tokensCss } = themeStylesheetText(resolved, () => null);
    expect(tokensCss).not.toContain('background-image');
  });

  it('escapes the asset url as a CSS string so it can never close url("…")', () => {
    const resolved = resolveThemeDocument(custom);
    const hostile = 'data:image/png;base64,AAAA\n); } body { display: none } .x { a: url("';
    const { tokensCss } = themeStylesheetText(resolved, () => hostile);
    expect(tokensCss).not.toContain('\n); }');
    expect(tokensCss).toContain('background-image: url("data:image/png;base64,AAAA\\a ); } body { display: none } .x { a: url(\\22 ");');
    expect(cssQuote('a"b\\c')).toBe('"a\\22 b\\5c c"');
  });
});
