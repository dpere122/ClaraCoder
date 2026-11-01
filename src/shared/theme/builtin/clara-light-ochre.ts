import type { ClaraThemeDocument } from '../theme-document';

const MONO_STACK = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace";

/** Light theme — Ochre: sun-baked sand surfaces, deep umber ink, golden ochre with a slate-blue counterpoint. */
export const CLARA_LIGHT_OCHRE_THEME: ClaraThemeDocument = {
  version: 1,
  id: 'clara-light-ochre',
  name: 'Clara Light Ochre',
  description: 'Ochre — warm sand surfaces with deep umber ink, golden ochre accents and a cool slate-blue counterpoint.',
  author: 'Clara Coder',
  mode: 'light',
  builtIn: true,
  tokens: {
    // Surfaces
    '--t-bg': '#fbf6ea',
    '--t-bg-surface': '#f4ead2',
    '--t-bg-deep': '#ebdcb8',
    '--t-panel': '#f8f1e0',
    '--t-chat-bg': 'color-mix(in srgb, var(--t-bg-surface) 62%, var(--t-bg))',
    '--t-input-bg': '#f4ead2',
    '--t-composer-bg': '#f0e3c4',
    '--t-composer-input-bg': '#f7eedb',
    '--t-composer-input-focus-bg': '#efe0bd',
    '--t-surface': 'var(--t-bg-surface)',
    '--t-surface-2': 'var(--t-bg-surface)',
    '--t-surface-3': 'var(--t-panel)',
    '--t-panel-bg': 'var(--t-panel)',

    // Text
    '--t-fg': '#3a2a12',
    '--t-primary': '#9a5b00',
    '--t-secondary': '#2f5d73',
    '--t-text-muted': '#7a6748',
    '--t-input-fg': '#3a2a12',
    '--t-on-primary': '#fffaf0',
    '--t-muted': 'var(--t-text-muted)',
    '--t-text': 'var(--t-fg)',
    '--t-heading': 'var(--t-primary)',
    '--t-fg-muted': 'var(--t-text-muted)',

    // Borders & edges
    '--t-border': '#dcc48e',
    '--t-border-subtle': '#e9d9b2',
    '--t-edge-light': '#fffcf4',
    '--t-edge-mid': '#efe0bd',
    '--t-edge-dark': '#c09a52',
    '--t-edge-darkest': '#6b4a17',
    '--t-tui-frame': '#c09a52',
    '--t-tui-user-frame': '#2f5d73',
    '--t-tui-clara-frame': '#9a5b00',
    '--t-tui-input-frame': '#9a5b00',

    // Interaction
    '--t-hover-bg': '#f2e4c2',
    '--t-active-bg': '#ead6a6',
    '--t-selection-bg': '#e0a83a4d',
    '--t-glow': 'transparent',
    '--t-glow-soft': 'transparent',
    '--t-elev-shadow': '0 10px 28px color-mix(in srgb, var(--t-edge-darkest) 28%, transparent)',

    // Chat bubbles
    '--t-user-bg': '#f0dfb4',
    '--t-user-fg': '#3a2a12',
    '--t-user-border': '#9a5b0066',
    '--t-assistant-bg': '#fdf9f0',
    '--t-assistant-fg': '#4a3820',
    '--t-assistant-border': '#d6bd85',

    // Code
    '--t-code-bg': '#f7eedb',
    '--t-code-inline-bg': '#efe2c2',
    '--t-code-text': '#3d2d15',

    // Syntax
    '--t-hljs-keyword': '#9a4a00',
    '--t-hljs-string': '#4f7a1f',
    '--t-hljs-number': '#2f5d73',
    '--t-hljs-comment': '#9a8a6a',
    '--t-hljs-function': '#8a3b5c',
    '--t-hljs-class': '#1f6a6a',
    '--t-hljs-attr': '#a0461c',
    '--t-hljs-params': '#4a3820',
    '--t-hljs-property': '#6b4a17',
    '--t-hljs-punctuation': '#7a6748',
    '--t-hljs-operator': '#9a4a00',
    '--t-hljs-meta': '#6a5a8a',
    '--t-hljs-tag': '#9a4a00',
    '--t-hljs-name': '#8a3b5c',
    '--t-hljs-symbol': '#2f5d73',
    '--t-hljs-selector': '#4f7a1f',

    // Status & decisions (deep fills so light ink stays readable on filled buttons)
    '--t-confirm': '#2f7a3f',
    '--t-caution': '#b8620b',
    '--t-log-level-error': '#b3261e',
    '--t-log-level-warning': '#b45309',
    '--t-log-level-info': '#2f5d73',
    '--t-log-level-debug': 'var(--t-text-muted)',
    '--t-process-a': '#9a5b00',
    '--t-process-b': '#2f5d73',
    '--t-process-c': '#8a3b5c',
    '--t-run-command-tab': '#1f6a6a',
    '--t-progress-track': 'var(--t-border-subtle)',
    '--t-progress-fill': 'var(--t-primary)',
    '--t-warn': 'var(--t-log-level-warning)',
    '--t-danger': 'var(--t-log-level-error)',
    '--t-error': 'var(--t-log-level-error)',
    '--t-success': 'var(--t-confirm)',

    // Typography
    '--t-font': MONO_STACK,
    '--t-font-mono': 'var(--t-font)',
    '--t-mono': 'var(--t-font-mono)',
    '--t-mono-font': 'var(--t-font-mono)',

    // Title bar
    '--t-titlebar-start': '#f0dfb4',
    '--t-titlebar-end': '#e3c98a',
    '--t-titlebar-text': '#3a2a12',
  },
  groups: {
    // Light surfaces need a flat code-block shell and surface-toned stream pills.
    'chat.transcript': {
      css: [
        '.terminal-shell { background: var(--t-code-bg); }',
        '.msg-restore-btn { text-shadow: none; }',
        'app-stream-thought-pill .stream-thought-preview__inner,',
        'app-stream-nudge-pill .stream-nudge-preview__inner {',
        '  background: var(--t-assistant-bg);',
        '  border: 1px solid var(--t-assistant-border) !important;',
        '  border-radius: 0.95rem !important;',
        '}',
        'app-stream-thought-pill .stream-thought-preview__body,',
        'app-stream-nudge-pill .stream-nudge-preview__body { color: var(--t-assistant-fg); }',
      ].join('\n'),
    },
    'chat.composer': {
      css: '.composer-prompt { text-shadow: none; }',
    },
  },
  assets: {},
};
