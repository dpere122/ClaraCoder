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
  const red = readVar(root, '--t-hljs-string', '#7dff7d');
  const cyan = readVar(root, '--t-process-a', '#41ffc9');
  const magenta = readVar(root, '--t-process-b', '#ff41c8');
  const yellow = readVar(root, '--t-hljs-number', '#41ffc9');

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
    green: primary,
    yellow,
    blue: cyan,
    magenta,
    cyan,
    white: foreground,
    brightBlack: muted,
    brightRed: red,
    brightGreen: primary,
    brightYellow: yellow,
    brightBlue: cyan,
    brightMagenta: magenta,
    brightCyan: cyan,
    brightWhite: foreground,
  };
}
