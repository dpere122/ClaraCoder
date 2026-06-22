import { describe, expect, it } from 'vitest';
import {
  buildXterm256PaletteFromCss,
  buildXtermThemeFromCssVars,
  invalidateTerminalPaletteCache,
  readTerminalAnsiPalette,
} from './xterm-theme-from-css';

function fakeRoot(vars: Record<string, string>): CSSStyleDeclaration {
  return {
    getPropertyValue: (name: string) => vars[name] ?? '',
  } as CSSStyleDeclaration;
}

describe('buildXtermThemeFromCssVars', () => {
  it('reads mapped variables', () => {
    const theme = buildXtermThemeFromCssVars(
      fakeRoot({
        '--t-code-bg': '#112233',
        '--t-code-text': '#aabbcc',
        '--t-primary': '#00ff00',
        '--t-edge-darkest': '#010203',
        '--t-log-level-error': '#ff0000',
        '--t-hljs-string': '#00aa00',
        '--t-log-level-warning': '#cccc00',
        '--t-hljs-number': '#0000ff',
        '--t-hljs-class': '#aa00aa',
        '--t-hljs-function': '#00aaaa',
        '--t-text-muted': '#888888',
      }),
    );
    expect(theme.background).toBe('#112233');
    expect(theme.foreground).toBe('#aabbcc');
    expect(theme.cursor).toBe('#00ff00');
    expect(theme.red).toBe('#ff0000');
    expect(theme.green).toBe('#00aa00');
    expect(theme.black).toBe('#010203');
  });

  it('uses fallbacks when variables are empty', () => {
    const theme = buildXtermThemeFromCssVars(fakeRoot({}));
    expect(theme.background).toBe('#050d05');
    expect(theme.foreground).toBe('#c8e6c8');
  });
});

describe('readTerminalAnsiPalette', () => {
  it('returns 16 themed colors', () => {
    const palette = readTerminalAnsiPalette(
      fakeRoot({
        '--t-code-bg': '#111111',
        '--t-code-text': '#eeeeee',
        '--t-primary': '#aabbcc',
      }),
    );
    expect(palette).toHaveLength(16);
    expect(palette[7]).toBe('#eeeeee');
    expect(palette[15]).toBe('#aabbcc');
  });
});

describe('buildXterm256PaletteFromCss', () => {
  it('builds a 256-entry palette', () => {
    invalidateTerminalPaletteCache();
    const palette = buildXterm256PaletteFromCss(fakeRoot({}));
    expect(palette).toHaveLength(256);
    expect(palette[0]).toBeTruthy();
    expect(palette[255]).toBeTruthy();
  });
});
