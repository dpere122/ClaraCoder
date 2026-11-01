import type { ClaraThemeDocument } from '../theme-document';

const MONO_STACK = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace";

/** Default light theme — Mint Fresh: cool mint surfaces, deep evergreen ink and an emerald-mint accent. */
export const CLARA_LIGHT_THEME: ClaraThemeDocument = {
  version: 1,
  id: 'clara-light',
  name: 'Clara Light Mint',
  description: 'Mint fresh — cool mint surfaces with deep evergreen ink and crisp emerald accents.',
  author: 'Clara Coder',
  mode: 'light',
  builtIn: true,
  tokens: {
    // Surfaces
    '--t-bg': '#f1faf6',
    '--t-bg-surface': '#e3f4ec',
    '--t-bg-deep': '#d3ebe0',
    '--t-panel': '#eef8f3',
    '--t-chat-bg': 'color-mix(in srgb, var(--t-bg-surface) 62%, var(--t-bg))',
    '--t-input-bg': '#e3f4ec',
    '--t-composer-bg': '#dcf0e6',
    '--t-composer-input-bg': '#e8f6ef',
    '--t-composer-input-focus-bg': '#d6efe3',
    '--t-surface': 'var(--t-bg-surface)',
    '--t-surface-2': 'var(--t-bg-surface)',
    '--t-surface-3': 'var(--t-panel)',
    '--t-panel-bg': 'var(--t-panel)',

    // Text
    '--t-fg': '#12332b',
    '--t-primary': '#0b7a62',
    '--t-secondary': '#1f5f6b',
    '--t-text-muted': '#587a6e',
    '--t-input-fg': '#12332b',
    '--t-on-primary': '#f2fcf8',
    '--t-muted': 'var(--t-text-muted)',
    '--t-text': 'var(--t-fg)',
    '--t-heading': 'var(--t-primary)',
    '--t-fg-muted': 'var(--t-text-muted)',

    // Borders & edges
    '--t-border': '#a9d4c2',
    '--t-border-subtle': '#c6e5d7',
    '--t-edge-light': '#f8fdfb',
    '--t-edge-mid': '#d6efe3',
    '--t-edge-dark': '#7fb3a0',
    '--t-edge-darkest': '#3f6d5e',
    '--t-tui-frame': '#7fb3a0',
    '--t-tui-user-frame': '#1f5f6b',
    '--t-tui-clara-frame': '#0b7a62',
    '--t-tui-input-frame': '#0b7a62',

    // Interaction
    '--t-hover-bg': '#dcf2e8',
    '--t-active-bg': '#c8eadb',
    '--t-selection-bg': '#5fd3a84d',
    '--t-glow': 'transparent',
    '--t-glow-soft': 'transparent',
    '--t-elev-shadow': '0 10px 28px color-mix(in srgb, var(--t-edge-darkest) 30%, transparent)',

    // Chat bubbles
    '--t-user-bg': '#d2efe2',
    '--t-user-fg': '#12332b',
    '--t-user-border': '#0b7a6266',
    '--t-assistant-bg': '#f7fdfa',
    '--t-assistant-fg': '#24463c',
    '--t-assistant-border': '#9ccbb8',

    // Code
    '--t-code-bg': '#e6f5ee',
    '--t-code-inline-bg': '#d8efe4',
    '--t-code-text': '#173b31',

    // Syntax
    '--t-hljs-keyword': '#0a7a66',
    '--t-hljs-string': '#b3541e',
    '--t-hljs-number': '#1d63a8',
    '--t-hljs-comment': '#7a978c',
    '--t-hljs-function': '#7b3fa0',
    '--t-hljs-class': '#0f6c8a',
    '--t-hljs-attr': '#946200',
    '--t-hljs-params': '#24463c',
    '--t-hljs-property': '#2c6a5a',
    '--t-hljs-punctuation': '#587a6e',
    '--t-hljs-operator': '#0a7a66',
    '--t-hljs-meta': '#6b5fa8',
    '--t-hljs-tag': '#0a7a66',
    '--t-hljs-name': '#7b3fa0',
    '--t-hljs-symbol': '#1d63a8',
    '--t-hljs-selector': '#b3541e',

    // Status & decisions (deep fills so light ink stays readable on filled buttons)
    '--t-confirm': '#0f7a4f',
    '--t-caution': '#b8620b',
    '--t-log-level-error': '#b3261e',
    '--t-log-level-warning': '#b45309',
    '--t-log-level-info': '#1d63a8',
    '--t-log-level-debug': 'var(--t-text-muted)',
    '--t-process-a': '#0b7a62',
    '--t-process-b': '#1f5f6b',
    '--t-process-c': '#7b3fa0',
    '--t-run-command-tab': '#0f6c8a',
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
    '--t-titlebar-start': '#cdeedf',
    '--t-titlebar-end': '#b3e2cd',
    '--t-titlebar-text': '#12332b',
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
