import type { ClaraThemeDocument } from '../theme-document';

const MONO_STACK = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace";

/** Default light theme — parchment surfaces with deep brown ink (the former Classical palette). */
export const CLARA_LIGHT_THEME: ClaraThemeDocument = {
  version: 1,
  id: 'clara-light',
  name: 'Clara Light',
  description: 'Parchment surfaces with deep brown ink and muted jewel-tone syntax.',
  author: 'Clara Coder',
  mode: 'light',
  builtIn: true,
  tokens: {
    // Surfaces
    '--t-bg': '#f5f0e8',
    '--t-bg-surface': '#ebe5d9',
    '--t-bg-deep': '#e0d8c8',
    '--t-panel': '#f3ede4',
    '--t-chat-bg': 'color-mix(in srgb, var(--t-bg-surface) 62%, var(--t-bg))',
    '--t-input-bg': '#ebe5d9',
    '--t-composer-bg': '#e8dfd0',
    '--t-composer-input-bg': '#ebe5d9',
    '--t-composer-input-focus-bg': '#e0d6c6',
    '--t-surface': 'var(--t-bg-surface)',
    '--t-surface-2': 'var(--t-bg-surface)',
    '--t-surface-3': 'var(--t-panel)',
    '--t-panel-bg': 'var(--t-panel)',

    // Text
    '--t-fg': '#2c1810',
    '--t-primary': '#2c1810',
    '--t-secondary': '#5c3d2e',
    '--t-text-muted': '#8a7a68',
    '--t-input-fg': '#2c1810',
    '--t-on-primary': '#f5f0e8',
    '--t-muted': 'var(--t-text-muted)',
    '--t-text': 'var(--t-fg)',
    '--t-heading': 'var(--t-primary)',
    '--t-fg-muted': 'var(--t-text-muted)',

    // Borders & edges
    '--t-border': '#c4b5a0',
    '--t-border-subtle': '#d4c8b4',
    '--t-edge-light': '#f6f0e6',
    '--t-edge-mid': '#e0d6c6',
    '--t-edge-dark': '#a58d74',
    '--t-edge-darkest': '#715843',
    '--t-tui-frame': '#8a7a68',
    '--t-tui-user-frame': '#5c3d2e',
    '--t-tui-clara-frame': '#5c4030',
    '--t-tui-input-frame': '#5c3d2e',

    // Interaction
    '--t-hover-bg': '#e8dfd0',
    '--t-active-bg': '#ddd3c0',
    '--t-selection-bg': '#c9b99a80',
    '--t-glow': 'transparent',
    '--t-glow-soft': 'transparent',
    '--t-elev-shadow': '0 10px 28px color-mix(in srgb, var(--t-edge-darkest) 42%, transparent)',

    // Chat bubbles
    '--t-user-bg': '#ddd0bc',
    '--t-user-fg': '#2c1810',
    '--t-user-border': '#a0806088',
    '--t-assistant-bg': '#f8f4ec',
    '--t-assistant-fg': '#5c4030',
    '--t-assistant-border': '#a08060',

    // Code
    '--t-code-bg': '#ebe5d9',
    '--t-code-inline-bg': '#e5ddd0',
    '--t-code-text': '#3d2b1f',

    // Syntax
    '--t-hljs-keyword': '#7b3014',
    '--t-hljs-string': '#2e6b2e',
    '--t-hljs-number': '#1a5276',
    '--t-hljs-comment': '#8a7a68',
    '--t-hljs-function': '#6b3a8a',
    '--t-hljs-class': '#5b2c6f',
    '--t-hljs-attr': '#7b5b3a',
    '--t-hljs-params': '#4a3520',
    '--t-hljs-property': '#6b5040',
    '--t-hljs-punctuation': '#8a7a68',
    '--t-hljs-operator': '#7b3014',
    '--t-hljs-meta': '#5b6b50',
    '--t-hljs-tag': '#7b3014',
    '--t-hljs-name': '#6b3a8a',
    '--t-hljs-symbol': '#1a5276',
    '--t-hljs-selector': '#2e6b2e',

    // Status & decisions (deep fills so light ink stays readable on filled buttons)
    '--t-confirm': '#1f7a4f',
    '--t-caution': '#bd640b',
    '--t-log-level-error': '#b3261e',
    '--t-log-level-warning': '#b45309',
    '--t-log-level-info': '#1f5f8b',
    '--t-log-level-debug': 'var(--t-text-muted)',
    '--t-process-a': '#7b5b3a',
    '--t-process-b': '#5c3d2e',
    '--t-process-c': '#6b3a8a',
    '--t-run-command-tab': '#6b3a8a',
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
    '--t-titlebar-start': '#d8c8b2',
    '--t-titlebar-end': '#c5b399',
    '--t-titlebar-text': '#2c1810',
  },
  groups: {
    // Light paper needs a flat code-block shell and paper-toned stream pills.
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
