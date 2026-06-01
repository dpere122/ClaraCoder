/** Escape sequences we render as styled spans in static terminal output. */
const SGR_PATTERN = /\x1b\[([0-9;]*)m/g;
/** Other CSI / OSC sequences are stripped (cursor moves, title changes, etc.). */
const STRIP_PATTERN = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?9;]*[ -/]*[@-~])/g;

const FG_CLASS: Record<number, string> = {
  30: 'ansi-fg-black',
  31: 'ansi-fg-red',
  32: 'ansi-fg-green',
  33: 'ansi-fg-yellow',
  34: 'ansi-fg-blue',
  35: 'ansi-fg-magenta',
  36: 'ansi-fg-cyan',
  37: 'ansi-fg-white',
  90: 'ansi-fg-bright-black',
  91: 'ansi-fg-bright-red',
  92: 'ansi-fg-bright-green',
  93: 'ansi-fg-bright-yellow',
  94: 'ansi-fg-bright-blue',
  95: 'ansi-fg-bright-magenta',
  96: 'ansi-fg-bright-cyan',
  97: 'ansi-fg-bright-white',
};

const BG_CLASS: Record<number, string> = {
  40: 'ansi-bg-black',
  41: 'ansi-bg-red',
  42: 'ansi-bg-green',
  43: 'ansi-bg-yellow',
  44: 'ansi-bg-blue',
  45: 'ansi-bg-magenta',
  46: 'ansi-bg-cyan',
  47: 'ansi-bg-white',
  100: 'ansi-bg-bright-black',
  101: 'ansi-bg-bright-red',
  102: 'ansi-bg-bright-green',
  103: 'ansi-bg-bright-yellow',
  104: 'ansi-bg-bright-blue',
  105: 'ansi-bg-bright-magenta',
  106: 'ansi-bg-bright-cyan',
  107: 'ansi-bg-bright-white',
};

const XTERM_256 = buildXterm256Palette();

interface AnsiStyleState {
  readonly classes: Set<string>;
  fgColor: string | null;
  bgColor: string | null;
}

function buildXterm256Palette(): string[] {
  const palette: string[] = [];
  for (let i = 0; i < 256; i++) {
    palette.push(xterm256Color(i));
  }
  return palette;
}

function xterm256Color(index: number): string {
  if (index < 16) {
    const base = [
      '#000000',
      '#cd3131',
      '#0dbc79',
      '#e5e510',
      '#2472c8',
      '#bc3fbc',
      '#11a8cd',
      '#e5e5e5',
      '#666666',
      '#f14c4c',
      '#23d18b',
      '#f5f543',
      '#3b8eea',
      '#d670d6',
      '#29b8db',
      '#ffffff',
    ];
    return base[index] ?? '#ffffff';
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

function rgb(r: number, g: number, b: number): string {
  return `rgb(${r}, ${g}, ${b})`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function emptyStyle(): AnsiStyleState {
  return { classes: new Set<string>(), fgColor: null, bgColor: null };
}

function styleSignature(state: AnsiStyleState): string {
  const cls = [...state.classes].sort().join(',');
  return `${cls}|${state.fgColor ?? ''}|${state.bgColor ?? ''}`;
}

function openSpan(state: AnsiStyleState): string {
  const attrs: string[] = [];
  if (state.classes.size > 0) {
    attrs.push(`class="${[...state.classes].join(' ')}"`);
  }
  const styles: string[] = [];
  if (state.fgColor) {
    styles.push(`color:${state.fgColor}`);
  }
  if (state.bgColor) {
    styles.push(`background-color:${state.bgColor}`);
  }
  if (styles.length > 0) {
    attrs.push(`style="${styles.join(';')}"`);
  }
  if (attrs.length === 0) {
    return '';
  }
  return `<span ${attrs.join(' ')}>`;
}

function applySgrParams(state: AnsiStyleState, params: number[]): void {
  if (params.length === 0) {
    params.push(0);
  }
  for (let i = 0; i < params.length; i++) {
    const code = params[i]!;
    if (code === 0) {
      state.classes.clear();
      state.fgColor = null;
      state.bgColor = null;
      continue;
    }
    if (code === 1) {
      state.classes.add('ansi-bold');
      continue;
    }
    if (code === 2) {
      state.classes.add('ansi-dim');
      continue;
    }
    if (code === 3) {
      state.classes.add('ansi-italic');
      continue;
    }
    if (code === 4) {
      state.classes.add('ansi-underline');
      continue;
    }
    if (code === 22) {
      state.classes.delete('ansi-bold');
      state.classes.delete('ansi-dim');
      continue;
    }
    if (code === 23) {
      state.classes.delete('ansi-italic');
      continue;
    }
    if (code === 24) {
      state.classes.delete('ansi-underline');
      continue;
    }
    if (code === 39) {
      state.fgColor = null;
      for (const cls of [...state.classes]) {
        if (cls.startsWith('ansi-fg-')) {
          state.classes.delete(cls);
        }
      }
      continue;
    }
    if (code === 49) {
      state.bgColor = null;
      for (const cls of [...state.classes]) {
        if (cls.startsWith('ansi-bg-')) {
          state.classes.delete(cls);
        }
      }
      continue;
    }
    const fg = FG_CLASS[code];
    if (fg) {
      state.fgColor = null;
      for (const cls of [...state.classes]) {
        if (cls.startsWith('ansi-fg-')) {
          state.classes.delete(cls);
        }
      }
      state.classes.add(fg);
      continue;
    }
    const bg = BG_CLASS[code];
    if (bg) {
      state.bgColor = null;
      for (const cls of [...state.classes]) {
        if (cls.startsWith('ansi-bg-')) {
          state.classes.delete(cls);
        }
      }
      state.classes.add(bg);
      continue;
    }
    if (code === 38 || code === 48) {
      const isFg = code === 38;
      const mode = params[i + 1];
      if (mode === 5 && i + 2 < params.length) {
        const colorIndex = params[i + 2]!;
        i += 2;
        if (isFg) {
          state.fgColor = XTERM_256[colorIndex] ?? null;
          for (const cls of [...state.classes]) {
            if (cls.startsWith('ansi-fg-')) {
              state.classes.delete(cls);
            }
          }
        } else {
          state.bgColor = XTERM_256[colorIndex] ?? null;
          for (const cls of [...state.classes]) {
            if (cls.startsWith('ansi-bg-')) {
              state.classes.delete(cls);
            }
          }
        }
        continue;
      }
      if (mode === 2 && i + 4 < params.length) {
        const r = params[i + 2]!;
        const g = params[i + 3]!;
        const b = params[i + 4]!;
        i += 4;
        const color = rgb(r, g, b);
        if (isFg) {
          state.fgColor = color;
          for (const cls of [...state.classes]) {
            if (cls.startsWith('ansi-fg-')) {
              state.classes.delete(cls);
            }
          }
        } else {
          state.bgColor = color;
          for (const cls of [...state.classes]) {
            if (cls.startsWith('ansi-bg-')) {
              state.classes.delete(cls);
            }
          }
        }
      }
    }
  }
}

function parseSgrParams(raw: string): number[] {
  if (!raw) {
    return [0];
  }
  return raw.split(';').map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

/** Convert terminal output with ANSI SGR codes into safe HTML for `<pre>` rendering. */
export function ansiTerminalOutputHtml(raw: string): string {
  if (!raw) {
    return '';
  }
  if (!raw.includes('\x1b')) {
    return escapeHtml(raw);
  }

  const stripped = raw.replace(STRIP_PATTERN, (seq) => (seq.endsWith('m') ? seq : ''));
  const state = emptyStyle();
  let out = '';
  let lastIndex = 0;
  let activeSignature = '';

  const closeActiveSpan = (): void => {
    if (activeSignature) {
      out += '</span>';
      activeSignature = '';
    }
  };

  const ensureSpanForState = (): void => {
    const signature = styleSignature(state);
    if (signature === activeSignature) {
      return;
    }
    closeActiveSpan();
    const open = openSpan(state);
    if (open) {
      out += open;
      activeSignature = signature;
    }
  };

  SGR_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SGR_PATTERN.exec(stripped)) !== null) {
    const chunk = stripped.slice(lastIndex, match.index);
    if (chunk) {
      ensureSpanForState();
      out += escapeHtml(chunk);
    }
    applySgrParams(state, parseSgrParams(match[1] ?? ''));
    lastIndex = match.index + match[0].length;
  }

  const tail = stripped.slice(lastIndex);
  if (tail) {
    ensureSpanForState();
    out += escapeHtml(tail);
  }
  closeActiveSpan();

  return out;
}
