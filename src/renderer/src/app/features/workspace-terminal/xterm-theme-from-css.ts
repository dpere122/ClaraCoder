import type { ITheme } from '@xterm/xterm';

function readVar(root: CSSStyleDeclaration, name: string, fallback: string): string {
  const v = root.getPropertyValue(name).trim();
  return v || fallback;
}

/** Maps app theme CSS variables on `:root` to an xterm.js theme. */
export function buildXtermThemeFromCssVars(root: CSSStyleDeclaration): ITheme {
  const background = readVar(root, '--t-code-bg', '#050d05');
  const foreground = readVar(root, '--t-code-text', '#c8e6c8');
  const primary = readVar(root, '--t-primary', '#00ff41');
  const muted = readVar(root, '--t-text-muted', '#4a7a4a');
  const selectionBg = readVar(root, '--t-selection-bg', '#00ff4140');
  const red = '#f14c4c';
  const green = '#23d18b';
  const yellow = '#f5f543';
  const blue = '#3b8eea';
  const magenta = '#d670d6';
  const cyan = '#29b8db';

  return {
    background,
    foreground,
    cursor: primary,
    cursorAccent: background,
    selectionBackground: selectionBg,
    selectionForeground: foreground,
    selectionInactiveBackground: selectionBg,
    black: background,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white: foreground,
    brightBlack: muted,
    brightRed: '#ff6b6b',
    brightGreen: '#7ae69b',
    brightYellow: '#ffff8f',
    brightBlue: '#79b8ff',
    brightMagenta: '#ff9cff',
    brightCyan: '#7eeeff',
    brightWhite: foreground,
  };
}
