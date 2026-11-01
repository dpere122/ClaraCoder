import type { ClaraThemeDocument } from '../theme-document';

const MONO_STACK = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace";

/** Dark theme — Cadmium Orange: warm charcoal surfaces, vivid cadmium orange with a cool steel-teal counterpoint. */
export const CLARA_DARK_CADMIUM_ORANGE_THEME: ClaraThemeDocument = {
  version: 1,
  id: 'clara-dark-cadmium-orange',
  name: 'Clara Dark Cadmium Orange',
  description: 'Warm charcoal surfaces lit by vivid cadmium orange, balanced with a cool steel-teal counterpoint.',
  author: 'Clara Coder',
  mode: 'dark',
  builtIn: true,
  tokens: {
    // Surfaces — warm charcoal, like pigment ground on slate
    '--t-bg': '#141110',
    '--t-bg-surface': '#1d1917',
    '--t-bg-deep': '#0e0c0b',
    '--t-panel': '#181514',
    '--t-chat-bg': 'color-mix(in srgb, var(--t-bg-surface) 62%, var(--t-bg))',
    '--t-input-bg': '#141110',
    '--t-composer-bg': '#0e0c0b',
    '--t-composer-input-bg': '#1d1917',
    '--t-composer-input-focus-bg': '#25201d',
    '--t-surface': 'var(--t-bg-surface)',
    '--t-surface-2': 'var(--t-bg-surface)',
    '--t-surface-3': 'var(--t-panel)',
    '--t-panel-bg': 'var(--t-panel)',

    // Text — warm parchment ink, cadmium orange, steel teal
    '--t-fg': '#ece4dc',
    '--t-primary': '#ff7a1a',
    '--t-secondary': '#4fc1c9',
    '--t-text-muted': '#9a8c80',
    '--t-input-fg': '#ece4dc',
    '--t-on-primary': '#1a0b02',
    '--t-muted': 'var(--t-text-muted)',
    '--t-text': 'var(--t-fg)',
    '--t-heading': 'var(--t-primary)',
    '--t-fg-muted': 'var(--t-text-muted)',

    // Borders & edges
    '--t-border': '#3d332d',
    '--t-border-subtle': '#2a2420',
    '--t-edge-light': '#54473f',
    '--t-edge-mid': '#332b26',
    '--t-edge-dark': '#1c1816',
    '--t-edge-darkest': '#080706',
    '--t-tui-frame': '#ff7a1a99',
    '--t-tui-user-frame': '#4fc1c9',
    '--t-tui-clara-frame': '#ff7a1a',
    '--t-tui-input-frame': '#ff7a1acc',

    // Interaction
    '--t-hover-bg': 'rgba(255, 122, 26, 0.08)',
    '--t-active-bg': 'rgba(255, 122, 26, 0.15)',
    '--t-selection-bg': 'rgba(255, 122, 26, 0.3)',
    '--t-glow': 'transparent',
    '--t-glow-soft': 'transparent',
    '--t-elev-shadow': '0 10px 28px color-mix(in srgb, var(--t-edge-darkest) 55%, transparent)',

    // Chat bubbles — your words in cool teal, Clara's in warm charcoal
    '--t-user-bg': '#16232a',
    '--t-user-fg': '#eef6f7',
    '--t-user-border': '#4fc1c955',
    '--t-assistant-bg': '#191513',
    '--t-assistant-fg': '#ddd3ca',
    '--t-assistant-border': '#43372f',

    // Code
    '--t-code-bg': '#110e0d',
    '--t-code-inline-bg': '#2a221d',
    '--t-code-text': '#ece4dc',

    // Syntax — warm pigments anchored on cadmium, cooled with teal and blue
    '--t-hljs-keyword': '#ff7a1a',
    '--t-hljs-string': '#a8d672',
    '--t-hljs-number': '#ffc457',
    '--t-hljs-comment': '#776a60',
    '--t-hljs-function': '#4fc1c9',
    '--t-hljs-class': '#ffb07a',
    '--t-hljs-attr': '#ffd27a',
    '--t-hljs-params': '#ece4dc',
    '--t-hljs-property': '#8ccfe0',
    '--t-hljs-punctuation': '#9a8c80',
    '--t-hljs-operator': '#ff9a4d',
    '--t-hljs-meta': '#d49bff',
    '--t-hljs-tag': '#ff7a1a',
    '--t-hljs-name': '#4fc1c9',
    '--t-hljs-symbol': '#ffc457',
    '--t-hljs-selector': '#a8d672',

    // Status & decisions
    '--t-confirm': '#4fd18b',
    '--t-caution': '#ffc457',
    '--t-log-level-error': '#ff5c5c',
    '--t-log-level-warning': '#ffc457',
    '--t-log-level-info': '#4fc1c9',
    '--t-log-level-debug': 'var(--t-text-muted)',
    '--t-process-a': '#ff7a1a',
    '--t-process-b': '#4fc1c9',
    '--t-process-c': '#ffc457',
    '--t-run-command-tab': '#4fc1c9',
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
    '--t-titlebar-start': '#231c18',
    '--t-titlebar-end': '#0e0c0b',
    '--t-titlebar-text': '#ece4dc',
  },
  groups: {
    // A thin cadmium seam under the title bar.
    'shell.titlebar': {
      css: '& { box-shadow: inset 0 -1px 0 rgba(255, 122, 26, 0.45); }',
    },
    // The composer warms to cadmium when focused.
    'chat.composer': {
      css: [
        '.composer-input-wrap { transition: box-shadow 0.2s ease; }',
        '.composer-input-wrap:focus-within { box-shadow: 0 0 0 1px rgba(255, 122, 26, 0.6), 0 0 14px rgba(255, 122, 26, 0.14); }',
      ].join('\n'),
    },
  },
  assets: {},
};
