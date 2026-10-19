import type { ClaraThemeDocument } from '../theme-document';

const MONO_STACK = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace";

/** Default dark theme — sage greens and warm amber (the former Woodland palette). */
export const CLARA_DARK_THEME: ClaraThemeDocument = {
  version: 1,
  id: 'clara-dark',
  name: 'Clara Dark',
  description: 'Sage green and warm amber on deep forest surfaces.',
  author: 'Clara Coder',
  mode: 'dark',
  builtIn: true,
  tokens: {
    // Surfaces
    '--t-bg': '#191c17',
    '--t-bg-surface': '#22261f',
    '--t-bg-deep': '#121410',
    '--t-panel': '#1e221b',
    '--t-chat-bg': 'color-mix(in srgb, var(--t-bg-surface) 62%, var(--t-bg))',
    '--t-input-bg': '#191c17',
    '--t-composer-bg': '#121410',
    '--t-composer-input-bg': '#22261f',
    '--t-composer-input-focus-bg': '#2a3024',
    '--t-surface': 'var(--t-bg-surface)',
    '--t-surface-2': 'var(--t-bg-surface)',
    '--t-surface-3': 'var(--t-panel)',
    '--t-panel-bg': 'var(--t-panel)',

    // Text
    '--t-fg': '#d2cdc2',
    '--t-primary': '#a8b89a',
    '--t-secondary': '#c9a96e',
    '--t-text-muted': '#7a8470',
    '--t-input-fg': '#d2cdc2',
    '--t-on-primary': '#121410',
    '--t-muted': 'var(--t-text-muted)',
    '--t-text': 'var(--t-fg)',
    '--t-heading': 'var(--t-primary)',
    '--t-fg-muted': 'var(--t-text-muted)',

    // Borders & edges
    '--t-border': '#3d4436',
    '--t-border-subtle': '#2e3429',
    '--t-edge-light': '#4a5442',
    '--t-edge-mid': '#343b2e',
    '--t-edge-dark': '#1e2319',
    '--t-edge-darkest': '#0d0f0b',
    '--t-tui-frame': '#c9a96e',
    '--t-tui-user-frame': '#d8c8a0',
    '--t-tui-clara-frame': '#a8b89a',
    '--t-tui-input-frame': '#c9a96ecc',

    // Interaction
    '--t-hover-bg': 'rgba(168, 184, 154, 0.1)',
    '--t-active-bg': 'rgba(168, 184, 154, 0.14)',
    '--t-selection-bg': 'rgba(168, 184, 154, 0.28)',
    '--t-glow': 'transparent',
    '--t-glow-soft': 'transparent',
    '--t-elev-shadow': '0 10px 28px color-mix(in srgb, var(--t-edge-darkest) 42%, transparent)',

    // Chat bubbles
    '--t-user-bg': '#2e3628',
    '--t-user-fg': '#d8c8a0',
    '--t-user-border': '#c9a96e66',
    '--t-assistant-bg': '#161812',
    '--t-assistant-fg': '#a8b89a',
    '--t-assistant-border': '#8a7a5a',

    // Code
    '--t-code-bg': '#151812',
    '--t-code-inline-bg': '#252b20',
    '--t-code-text': '#ddd8cc',

    // Syntax
    '--t-hljs-keyword': '#a8b89a',
    '--t-hljs-string': '#c9a96e',
    '--t-hljs-number': '#7eb5a6',
    '--t-hljs-comment': '#6b7361',
    '--t-hljs-function': '#d4c49a',
    '--t-hljs-class': '#b8a88a',
    '--t-hljs-attr': '#c4a87a',
    '--t-hljs-params': '#d2cdc2',
    '--t-hljs-property': '#9bb88e',
    '--t-hljs-punctuation': '#7a8470',
    '--t-hljs-operator': '#b89a7a',
    '--t-hljs-meta': '#8aaa80',
    '--t-hljs-tag': '#c49a70',
    '--t-hljs-name': '#a8b89a',
    '--t-hljs-symbol': '#7eb5a6',
    '--t-hljs-selector': '#9bb88e',

    // Status & decisions
    '--t-confirm': '#5fd39b',
    '--t-caution': '#e8b455',
    '--t-log-level-error': '#e07a7a',
    '--t-log-level-warning': '#d4a84b',
    '--t-log-level-info': '#6aa9e6',
    '--t-log-level-debug': 'var(--t-text-muted)',
    '--t-process-a': '#a8b89a',
    '--t-process-b': '#c9a96e',
    '--t-process-c': '#7eb5a6',
    '--t-run-command-tab': '#7eb5a6',
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
    '--t-titlebar-start': '#2a3024',
    '--t-titlebar-end': '#1a1e17',
    '--t-titlebar-text': '#d2cdc2',
  },
  groups: {},
  assets: {},
};
