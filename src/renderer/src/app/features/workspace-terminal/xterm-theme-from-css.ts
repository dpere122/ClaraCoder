import type { ITheme } from '@xterm/xterm';

type CssVarRoot = Pick<CSSStyleDeclaration, 'getPropertyValue'>;

export function readVar(root: CssVarRoot, name: string, fallback: string): string {
  const v = root.getPropertyValue(name).trim();
  return v || fallback;
}

/** Standard 16-color ANSI palette derived from active app theme tokens. */
export function readTerminalAnsiPalette(root: CssVarRoot): readonly string[] {
  const background = readVar(root, '--t-code-bg', '#050d05');
  const foreground = readVar(root, '--t-code-text', '#c8e6c8');
  return [
    readVar(root, '--t-edge-darkest', background),
    readVar(root, '--t-log-level-error', '#f14c4c'),
    readVar(root, '--t-hljs-string', '#23d18b'),
    readVar(root, '--t-log-level-warning', '#f5f543'),
    readVar(root, '--t-hljs-number', '#3b8eea'),
    readVar(root, '--t-hljs-class', '#d670d6'),
    readVar(root, '--t-hljs-function', '#29b8db'),
    foreground,
    readVar(root, '--t-text-muted', '#666666'),
    readVar(root, '--t-log-level-error', '#ff6b6b'),
    readVar(root, '--t-hljs-string', '#7ae69b'),
    readVar(root, '--t-log-level-warning', '#ffff8f'),
    readVar(root, '--t-hljs-number', '#79b8ff'),
    readVar(root, '--t-hljs-class', '#ff9cff'),
    readVar(root, '--t-hljs-function', '#7eeeff'),
    readVar(root, '--t-primary', foreground),
  ];
}

function rgb(r: number, g: number, b: number): string {
  return `rgb(${r}, ${g}, ${b})`;
}

function xterm256FromBase16(base: readonly string[], index: number): string {
  if (index < 16) {
    return base[index] ?? base[7] ?? '#ffffff';
  }
  if (index < 232) {
    const i = index - 16;
    const r = Math.floor(i / 36);
    const g = Math.floor((i % 36) / 6);
    const b = i % 6;
    const channel = (step: number) => (step === 0 ? 0 : 55 + step * 40);
    return rgb(channel(r), channel(g), channel(b));
  }
  const gray = 8 + (index - 232) * 10;
  return rgb(gray, gray, gray);
}

let cached256Key = '';
let cached256Palette: string[] | null = null;

function emptyCssRoot(): CssVarRoot {
  return { getPropertyValue: () => '' };
}

/** xterm 256-color palette using themed ANSI base (indices 0–15). */
export function buildXterm256PaletteFromCss(root?: CssVarRoot): string[] {
  const resolvedRoot =
    root ??
    (typeof document !== 'undefined' && document.documentElement
      ? getComputedStyle(document.documentElement)
      : emptyCssRoot());
  // The theme engine stamps `data-theme-id` / `data-theme-revision` on <html> after each apply.
  const key =
    typeof document !== 'undefined' && document.documentElement
      ? `${document.documentElement.getAttribute('data-theme-id') ?? ''}#${document.documentElement.getAttribute('data-theme-revision') ?? ''}`
      : readTerminalAnsiPalette(resolvedRoot).join('|');
  if (cached256Palette && cached256Key === key) {
    return cached256Palette;
  }
  cached256Key = key;
  const base = readTerminalAnsiPalette(resolvedRoot);
  cached256Palette = Array.from({ length: 256 }, (_, i) => xterm256FromBase16(base, i));
  return cached256Palette;
}

export function invalidateTerminalPaletteCache(): void {
  cached256Key = '';
  cached256Palette = null;
}

/** Maps app theme CSS variables on `:root` to an xterm.js theme. */
export function buildXtermThemeFromCssVars(root: CssVarRoot): ITheme {
  const background = readVar(root, '--t-code-bg', '#050d05');
  const foreground = readVar(root, '--t-code-text', '#c8e6c8');
  const primary = readVar(root, '--t-primary', '#00ff41');
  const selectionBg = readVar(root, '--t-selection-bg', '#00ff4140');
  const base = readTerminalAnsiPalette(root);

  return {
    background,
    foreground,
    cursor: primary,
    cursorAccent: background,
    selectionBackground: selectionBg,
    selectionForeground: foreground,
    selectionInactiveBackground: selectionBg,
    black: base[0]!,
    red: base[1]!,
    green: base[2]!,
    yellow: base[3]!,
    blue: base[4]!,
    magenta: base[5]!,
    cyan: base[6]!,
    white: base[7]!,
    brightBlack: base[8]!,
    brightRed: base[9]!,
    brightGreen: base[10]!,
    brightYellow: base[11]!,
    brightBlue: base[12]!,
    brightMagenta: base[13]!,
    brightCyan: base[14]!,
    brightWhite: base[15]!,
  };
}
