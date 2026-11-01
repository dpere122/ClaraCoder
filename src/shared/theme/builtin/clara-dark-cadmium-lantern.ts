import type { ClaraThemeDocument } from '../theme-document';

const MONO_STACK = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace";

/**
 * Dark theme — Cadmium Lantern: a lantern burning in the void. Deep forest-black surfaces, emerald
 * willpower light that glows on text and frames, cadmium yellow as the rival flame, and a slow
 * "charging" pulse on live elements (disabled under `prefers-reduced-motion`).
 */
export const CLARA_DARK_CADMIUM_LANTERN_THEME: ClaraThemeDocument = {
  version: 1,
  id: 'clara-dark-cadmium-lantern',
  name: 'Clara Dark Cadmium Lantern',
  description: 'In brightest day, in blackest night — emerald lantern light glowing over forest-black, with a cadmium yellow rival flame.',
  author: 'Clara Coder',
  mode: 'dark',
  builtIn: true,
  tokens: {
    // Surfaces — the void around the lantern, tinted faintly green
    '--t-bg': '#070d0a',
    '--t-bg-surface': '#0c1611',
    '--t-bg-deep': '#040806',
    '--t-panel': '#0a130e',
    '--t-chat-bg': 'color-mix(in srgb, var(--t-bg-surface) 62%, var(--t-bg))',
    '--t-input-bg': '#08100c',
    '--t-composer-bg': '#040806',
    '--t-composer-input-bg': '#0c1611',
    '--t-composer-input-focus-bg': '#0f1f16',
    '--t-surface': 'var(--t-bg-surface)',
    '--t-surface-2': 'var(--t-bg-surface)',
    '--t-surface-3': 'var(--t-panel)',
    '--t-panel-bg': 'var(--t-panel)',

    // Text — pale jade ink, willpower emerald, cadmium yellow
    '--t-fg': '#d8f5e3',
    '--t-primary': '#2bff88',
    '--t-secondary': '#ffd23f',
    '--t-text-muted': '#6f9a80',
    '--t-input-fg': '#e6fbef',
    '--t-on-primary': '#02140a',
    '--t-muted': 'var(--t-text-muted)',
    '--t-text': 'var(--t-fg)',
    '--t-heading': 'var(--t-primary)',
    '--t-fg-muted': 'var(--t-text-muted)',

    // Borders & edges — ring-forged metal edges catching green light
    '--t-border': '#1d4a32',
    '--t-border-subtle': '#12291c',
    '--t-edge-light': '#2f6e4a',
    '--t-edge-mid': '#173a27',
    '--t-edge-dark': '#0a1a11',
    '--t-edge-darkest': '#010402',
    '--t-tui-frame': '#2bff8866',
    '--t-tui-user-frame': '#ffd23f',
    '--t-tui-clara-frame': '#2bff88',
    '--t-tui-input-frame': '#2bff88cc',

    // Interaction — the light itself
    '--t-hover-bg': 'rgba(43, 255, 136, 0.07)',
    '--t-active-bg': 'rgba(43, 255, 136, 0.14)',
    '--t-selection-bg': 'rgba(43, 255, 136, 0.28)',
    '--t-glow': 'rgba(43, 255, 136, 0.55)',
    '--t-glow-soft': 'rgba(43, 255, 136, 0.22)',
    '--t-elev-shadow': '0 10px 30px rgba(0, 0, 0, 0.6), 0 0 22px rgba(43, 255, 136, 0.08)',

    // Chat bubbles — your words in cadmium, Clara's in emerald
    '--t-user-bg': '#161a0c',
    '--t-user-fg': '#fbf6dc',
    '--t-user-border': '#ffd23f66',
    '--t-assistant-bg': '#08130d',
    '--t-assistant-fg': '#cdeedb',
    '--t-assistant-border': '#2bff8840',

    // Code
    '--t-code-bg': '#050a07',
    '--t-code-inline-bg': '#10241a',
    '--t-code-text': '#d8f5e3',

    // Syntax — the emotional spectrum, anchored on willpower green
    '--t-hljs-keyword': '#2bff88',
    '--t-hljs-string': '#ffd23f',
    '--t-hljs-number': '#ff8a3d',
    '--t-hljs-comment': '#4f7a62',
    '--t-hljs-function': '#7ce8ff',
    '--t-hljs-class': '#b28cff',
    '--t-hljs-attr': '#c6ff5e',
    '--t-hljs-params': '#d8f5e3',
    '--t-hljs-property': '#8df5b8',
    '--t-hljs-punctuation': '#6f9a80',
    '--t-hljs-operator': '#5cffa3',
    '--t-hljs-meta': '#b28cff',
    '--t-hljs-tag': '#2bff88',
    '--t-hljs-name': '#7ce8ff',
    '--t-hljs-symbol': '#ff8a3d',
    '--t-hljs-selector': '#c6ff5e',

    // Status & decisions
    '--t-confirm': '#2bff88',
    '--t-caution': '#ffd23f',
    '--t-log-level-error': '#ff5c6c',
    '--t-log-level-warning': '#ffd23f',
    '--t-log-level-info': '#7ce8ff',
    '--t-log-level-debug': 'var(--t-text-muted)',
    '--t-process-a': '#2bff88',
    '--t-process-b': '#ffd23f',
    '--t-process-c': '#7ce8ff',
    '--t-run-command-tab': '#c6ff5e',
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

    // Title bar — the ring's band: forest metal fading into the void
    '--t-titlebar-start': '#0f2a1b',
    '--t-titlebar-end': '#040806',
    '--t-titlebar-text': '#8df5b8',
  },
  groups: {
    // The lantern hangs above the transcript: a faint emerald light pooling from the top,
    // and the live streaming cursor flickers like its flame.
    'chat.transcript': {
      css: [
        '@keyframes clara-lantern-flicker {',
        '  0%, 100% { opacity: 1; text-shadow: 0 0 8px var(--t-glow); }',
        '  45% { opacity: 0.75; text-shadow: 0 0 3px var(--t-glow-soft); }',
        '  60% { opacity: 0.95; text-shadow: 0 0 12px var(--t-glow); }',
        '}',
        '.chat-box {',
        '  background-image: radial-gradient(ellipse 80% 45% at 50% 0%, rgba(43, 255, 136, 0.07), transparent 70%);',
        '  background-attachment: local;',
        '}',
        '.streaming-cursor { color: var(--t-primary); text-shadow: 0 0 8px var(--t-glow); }',
        '@media (prefers-reduced-motion: no-preference) {',
        '  .streaming-cursor--live { animation: clara-lantern-flicker 1.4s ease-in-out infinite; }',
        '}',
      ].join('\n'),
    },
    // Clara speaks with lantern light: a soft inner glow on her messages (the bubble is the group root).
    'chat.assistant-bubble': {
      css: [
        '& { box-shadow: inset 0 0 18px rgba(43, 255, 136, 0.05), 0 0 12px rgba(43, 255, 136, 0.06); }',
        '.msg-role__name { text-shadow: 0 0 6px var(--t-glow); }',
      ].join('\n'),
    },
    // Your messages burn cadmium yellow — the rival flame.
    'chat.user-bubble': {
      css: [
        '& { box-shadow: 0 0 12px rgba(255, 210, 63, 0.07); }',
        '.msg-role__name { color: var(--t-secondary); text-shadow: 0 0 6px rgba(255, 210, 63, 0.45); }',
      ].join('\n'),
    },
    // The composer charges like a power battery while you type.
    'chat.composer': {
      css: [
        '@keyframes clara-lantern-charge {',
        '  0%, 100% { box-shadow: 0 0 6px rgba(43, 255, 136, 0.25), 0 0 0 1px rgba(43, 255, 136, 0.35); }',
        '  50% { box-shadow: 0 0 18px rgba(43, 255, 136, 0.45), 0 0 0 1px rgba(43, 255, 136, 0.7); }',
        '}',
        '.composer-input-wrap { transition: box-shadow 0.25s ease; }',
        '.composer-input-wrap:focus-within { box-shadow: 0 0 12px rgba(43, 255, 136, 0.35), 0 0 0 1px rgba(43, 255, 136, 0.55); }',
        '.composer-prompt--active { text-shadow: 0 0 8px var(--t-glow); }',
        '.btn-send { box-shadow: 0 0 10px var(--t-glow-soft); }',
        '@media (prefers-reduced-motion: no-preference) {',
        '  .composer-input-wrap:focus-within { animation: clara-lantern-charge 2.8s ease-in-out infinite; }',
        '}',
      ].join('\n'),
    },
    // A running tool pill glows while the lantern works (the pill is the group root).
    'chat.stream-pills': {
      css: '&.stream-tool-pill--running { box-shadow: 0 0 10px var(--t-glow-soft); }',
    },
    // Plan progress fills like a charging ring.
    'chat.plan-panel': {
      css: '.plan__bar-fill { box-shadow: 0 0 10px var(--t-glow); }',
    },
    // A thin emerald seam under the title bar — the band of the ring.
    'shell.titlebar': {
      css: [
        '& { box-shadow: inset 0 -1px 0 rgba(43, 255, 136, 0.35), 0 1px 12px rgba(43, 255, 136, 0.08); }',
        '.chrome-title { text-shadow: 0 0 8px var(--t-glow-soft); }',
      ].join('\n'),
    },
  },
  assets: {},
};
