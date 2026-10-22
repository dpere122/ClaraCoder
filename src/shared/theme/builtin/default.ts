import type { ClaraThemeDocument } from '../theme-document';

const MONO_STACK = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace";

/** Default dark theme — graphite surfaces from the app icon, electric blue with complementary amber. */
export const DEFAULT_THEME: ClaraThemeDocument = {
  version: 1,
  id: 'default',
  name: 'Default',
  description: 'Graphite surfaces with electric blue and complementary amber, matching the app icon.',
  author: 'Clara Coder',
  mode: 'dark',
  builtIn: true,
  tokens: {
    // Surfaces
    '--t-bg': '#141417',
    '--t-bg-surface': '#1c1c21',
    '--t-bg-deep': '#0f0f11',
    '--t-panel': '#18181c',
    '--t-chat-bg': 'color-mix(in srgb, var(--t-bg-surface) 62%, var(--t-bg))',
    '--t-input-bg': '#141417',
    '--t-composer-bg': '#0f0f11',
    '--t-composer-input-bg': '#1c1c21',
    '--t-composer-input-focus-bg': '#22232a',
    '--t-surface': 'var(--t-bg-surface)',
    '--t-surface-2': 'var(--t-bg-surface)',
    '--t-surface-3': 'var(--t-panel)',
    '--t-panel-bg': 'var(--t-panel)',

    // Text
    '--t-fg': '#e4e4e7',
    '--t-primary': '#4da3ff',
    '--t-secondary': '#ffb35c',
    '--t-text-muted': '#8b8b96',
    '--t-input-fg': '#e4e4e7',
    '--t-on-primary': '#0a0f1a',
    '--t-muted': 'var(--t-text-muted)',
    '--t-text': 'var(--t-fg)',
    '--t-heading': 'var(--t-primary)',
    '--t-fg-muted': 'var(--t-text-muted)',

    // Borders & edges
    '--t-border': '#34343c',
    '--t-border-subtle': '#26262c',
    '--t-edge-light': '#46464f',
    '--t-edge-mid': '#2e2e35',
    '--t-edge-dark': '#1a1a1e',
    '--t-edge-darkest': '#08080a',
    '--t-tui-frame': '#4da3ff99',
    '--t-tui-user-frame': '#ffb35c',
    '--t-tui-clara-frame': '#4da3ff',
    '--t-tui-input-frame': '#4da3ffcc',

    // Interaction
    '--t-hover-bg': 'rgba(77, 163, 255, 0.08)',
    '--t-active-bg': 'rgba(77, 163, 255, 0.14)',
    '--t-selection-bg': 'rgba(77, 163, 255, 0.3)',
    '--t-glow': 'transparent',
    '--t-glow-soft': 'transparent',
    '--t-elev-shadow': '0 10px 28px color-mix(in srgb, var(--t-edge-darkest) 50%, transparent)',

    // Chat bubbles
    '--t-user-bg': '#1d2430',
    '--t-user-fg': '#f4f4f5',
    '--t-user-border': '#4da3ff55',
    '--t-assistant-bg': '#17171b',
    '--t-assistant-fg': '#d4d4d8',
    '--t-assistant-border': '#3a3a42',

    // Code
    '--t-code-bg': '#101013',
    '--t-code-inline-bg': '#23232a',
    '--t-code-text': '#e4e4e7',

    // Syntax
    '--t-hljs-keyword': '#4da3ff',
    '--t-hljs-string': '#ffb35c',
    '--t-hljs-number': '#ff8f6b',
    '--t-hljs-comment': '#6b6b76',
    '--t-hljs-function': '#c4b5fd',
    '--t-hljs-class': '#5eead4',
    '--t-hljs-attr': '#fcd34d',
    '--t-hljs-params': '#e4e4e7',
    '--t-hljs-property': '#93c5fd',
    '--t-hljs-punctuation': '#8b8b96',
    '--t-hljs-operator': '#a1a1aa',
    '--t-hljs-meta': '#a78bfa',
    '--t-hljs-tag': '#4da3ff',
    '--t-hljs-name': '#7dd3fc',
    '--t-hljs-symbol': '#ff8f6b',
    '--t-hljs-selector': '#5eead4',

    // Status & decisions
    '--t-confirm': '#3ddc97',
    '--t-caution': '#ffb35c',
    '--t-log-level-error': '#ff6b6b',
    '--t-log-level-warning': '#fbbf24',
    '--t-log-level-info': '#4da3ff',
    '--t-log-level-debug': 'var(--t-text-muted)',
    '--t-process-a': '#4da3ff',
    '--t-process-b': '#ffb35c',
    '--t-process-c': '#5eead4',
    '--t-run-command-tab': '#5eead4',
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
    '--t-titlebar-start': '#1c1c21',
    '--t-titlebar-end': '#0f0f11',
    '--t-titlebar-text': '#e4e4e7',
  },
  groups: {},
  assets: {},
};
