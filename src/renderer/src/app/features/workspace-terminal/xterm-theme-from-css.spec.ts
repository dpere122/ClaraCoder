import { describe, expect, it } from 'vitest';
import { buildXtermThemeFromCssVars } from './xterm-theme-from-css';

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
      }),
    );
    expect(theme.background).toBe('#112233');
    expect(theme.foreground).toBe('#aabbcc');
    expect(theme.cursor).toBe('#00ff00');
  });

  it('uses fallbacks when variables are empty', () => {
    const theme = buildXtermThemeFromCssVars(fakeRoot({}));
    expect(theme.background).toBe('#050d05');
    expect(theme.foreground).toBe('#c8e6c8');
  });
});
