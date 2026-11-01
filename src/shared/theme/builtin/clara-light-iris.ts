import type { ClaraThemeDocument } from '../theme-document';

const MONO_STACK = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace";

/** Light theme — Iris: lavender petal surfaces, deep indigo ink, iris violet with a golden-beard accent. */
export const CLARA_LIGHT_IRIS_THEME: ClaraThemeDocument = {
  version: 1,
  id: 'clara-light-iris',
  name: 'Clara Light Iris',
  description: 'Iris — soft lavender petals with deep indigo ink, iris violet accents and a touch of golden yellow.',
  author: 'Clara Coder',
  mode: 'light',
  builtIn: true,
  tokens: {
    // Surfaces
    '--t-bg': '#f7f5fd',
    '--t-bg-surface': '#ece8fa',
    '--t-bg-deep': '#ded8f3',
    '--t-panel': '#f3f0fc',
    '--t-chat-bg': 'color-mix(in srgb, var(--t-bg-surface) 62%, var(--t-bg))',
    '--t-input-bg': '#ece8fa',
    '--t-composer-bg': '#e6e0f8',
    '--t-composer-input-bg': '#f0edfb',
    '--t-composer-input-focus-bg': '#e2dcf6',
    '--t-surface': 'var(--t-bg-surface)',
    '--t-surface-2': 'var(--t-bg-surface)',
    '--t-surface-3': 'var(--t-panel)',
    '--t-panel-bg': 'var(--t-panel)',

    // Text
    '--t-fg': '#231a45',
    '--t-primary': '#5b3fc0',
    '--t-secondary': '#8a5a00',
    '--t-text-muted': '#6c6490',
    '--t-input-fg': '#231a45',
    '--t-on-primary': '#faf8ff',
    '--t-muted': 'var(--t-text-muted)',
    '--t-text': 'var(--t-fg)',
    '--t-heading': 'var(--t-primary)',
    '--t-fg-muted': 'var(--t-text-muted)',

    // Borders & edges
    '--t-border': '#c3b8ea',
    '--t-border-subtle': '#d9d2f3',
    '--t-edge-light': '#fcfbff',
    '--t-edge-mid': '#e2dcf6',
    '--t-edge-dark': '#9d90cf',
    '--t-edge-darkest': '#4f4482',
    '--t-tui-frame': '#9d90cf',
    '--t-tui-user-frame': '#b8860b',
    '--t-tui-clara-frame': '#5b3fc0',
    '--t-tui-input-frame': '#5b3fc0',

    // Interaction
    '--t-hover-bg': '#e7e2f9',
    '--t-active-bg': '#d8d0f4',
    '--t-selection-bg': '#8b6fe84d',
    '--t-glow': 'transparent',
    '--t-glow-soft': 'transparent',
    '--t-elev-shadow': '0 10px 28px color-mix(in srgb, var(--t-edge-darkest) 30%, transparent)',

    // Chat bubbles
    '--t-user-bg': '#e3dcfa',
    '--t-user-fg': '#231a45',
    '--t-user-border': '#5b3fc066',
    '--t-assistant-bg': '#fbfaff',
    '--t-assistant-fg': '#342a5c',
    '--t-assistant-border': '#b9addf',

    // Code
    '--t-code-bg': '#efebfb',
    '--t-code-inline-bg': '#e4def8',
    '--t-code-text': '#2b2150',

    // Syntax
    '--t-hljs-keyword': '#5b3fc0',
    '--t-hljs-string': '#8a5a00',
    '--t-hljs-number': '#b02a6b',
    '--t-hljs-comment': '#8a83a8',
    '--t-hljs-function': '#1f5fa8',
    '--t-hljs-class': '#0e7490',
    '--t-hljs-attr': '#9a4f00',
    '--t-hljs-params': '#342a5c',
    '--t-hljs-property': '#4a3f8a',
    '--t-hljs-punctuation': '#6c6490',
    '--t-hljs-operator': '#5b3fc0',
    '--t-hljs-meta': '#7a4fa8',
    '--t-hljs-tag': '#5b3fc0',
    '--t-hljs-name': '#1f5fa8',
    '--t-hljs-symbol': '#b02a6b',
    '--t-hljs-selector': '#8a5a00',

    // Status & decisions (deep fills so light ink stays readable on filled buttons)
    '--t-confirm': '#1f7a4f',
    '--t-caution': '#b8620b',
    '--t-log-level-error': '#b3261e',
    '--t-log-level-warning': '#b45309',
    '--t-log-level-info': '#1f5fa8',
    '--t-log-level-debug': 'var(--t-text-muted)',
    '--t-process-a': '#5b3fc0',
    '--t-process-b': '#8a5a00',
    '--t-process-c': '#b02a6b',
    '--t-run-command-tab': '#0e7490',
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
    '--t-titlebar-start': '#e0d8f7',
    '--t-titlebar-end': '#cbbff0',
    '--t-titlebar-text': '#231a45',
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
