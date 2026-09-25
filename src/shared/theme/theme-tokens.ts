/**
 * Canonical catalog of app design tokens (`--t-*` CSS custom properties).
 *
 * Every token the renderer CSS consumes is listed here so a theme document can be
 * validated, the Settings editor knows which control to render, and the agent tool
 * schema can enumerate exactly what is themeable. Values are plain CSS strings; a
 * token may reference another token with `var(--t-…)` (alias tokens do this by default).
 *
 * No Node / DOM imports — shared by Electron main, the renderer, and the codegen script.
 */

export type ThemeTokenKind = 'color' | 'font' | 'length' | 'shadow' | 'raw';

export type ThemeTokenCategoryId =
  | 'surfaces'
  | 'text'
  | 'borders'
  | 'interaction'
  | 'chat'
  | 'code'
  | 'syntax'
  | 'status'
  | 'typography'
  | 'titlebar';

export interface ThemeTokenCategory {
  id: ThemeTokenCategoryId;
  label: string;
  description: string;
}

export interface ThemeTokenDef {
  /** CSS custom property name, including the `--t-` prefix. */
  name: string;
  label: string;
  category: ThemeTokenCategoryId;
  kind: ThemeTokenKind;
  description?: string;
  /**
   * Alias tokens default to `var(--t-<other>)` in the built-ins and exist so component CSS
   * that reads them (with fallbacks) becomes themeable without touching each stylesheet.
   */
  alias?: boolean;
}

export const THEME_TOKEN_CATEGORIES: readonly ThemeTokenCategory[] = [
  { id: 'surfaces', label: 'Surfaces', description: 'Window, panel, input, and composer backgrounds.' },
  { id: 'text', label: 'Text', description: 'Foreground, primary/secondary emphasis, and muted text.' },
  { id: 'borders', label: 'Borders & edges', description: 'Dividers, bevel edges, and ASCII frame colors.' },
  { id: 'interaction', label: 'Interaction', description: 'Hover, active, selection, glow, and elevation.' },
  { id: 'chat', label: 'Chat bubbles', description: 'User and assistant message bubble colors.' },
  { id: 'code', label: 'Code', description: 'Code block and inline code surfaces.' },
  { id: 'syntax', label: 'Syntax highlighting', description: 'highlight.js token colors (also seeds the Monaco palette).' },
  { id: 'status', label: 'Status & decisions', description: 'Success, warning, error, and process indicator colors.' },
  { id: 'typography', label: 'Typography', description: 'Default UI and monospace font stacks.' },
  { id: 'titlebar', label: 'Title bar', description: 'Frameless window title bar gradient and text.' },
];

const T = (
  name: string,
  label: string,
  category: ThemeTokenCategoryId,
  kind: ThemeTokenKind = 'color',
  extra: Partial<Pick<ThemeTokenDef, 'description' | 'alias'>> = {},
): ThemeTokenDef => ({ name, label, category, kind, ...extra });

export const THEME_TOKENS: readonly ThemeTokenDef[] = [
  // Surfaces
  T('--t-bg', 'App background', 'surfaces'),
  T('--t-bg-surface', 'Surface', 'surfaces', 'color', { description: 'Raised panels, cards, and inputs.' }),
  T('--t-bg-deep', 'Deep background', 'surfaces', 'color', { description: 'Recessed areas such as terminals and the composer shell.' }),
  T('--t-panel', 'Panel', 'surfaces'),
  T('--t-chat-bg', 'Chat transcript', 'surfaces', 'color', { description: 'Background of the chat transcript panel.' }),
  T('--t-input-bg', 'Input background', 'surfaces'),
  T('--t-composer-bg', 'Composer shell', 'surfaces'),
  T('--t-composer-input-bg', 'Composer input', 'surfaces'),
  T('--t-composer-input-focus-bg', 'Composer input (focus)', 'surfaces'),
  T('--t-surface', 'Surface (alias)', 'surfaces', 'color', { alias: true }),
  T('--t-surface-2', 'Surface 2 (alias)', 'surfaces', 'color', { alias: true }),
  T('--t-surface-3', 'Surface 3 (alias)', 'surfaces', 'color', { alias: true }),
  T('--t-panel-bg', 'Panel background (alias)', 'surfaces', 'color', { alias: true }),

  // Text
  T('--t-fg', 'Foreground', 'text'),
  T('--t-primary', 'Primary', 'text', 'color', { description: 'Headings, active controls, and emphasis.' }),
  T('--t-secondary', 'Secondary / accent', 'text', 'color', { description: 'Links, accents, and composer prompt.' }),
  T('--t-text-muted', 'Muted text', 'text'),
  T('--t-input-fg', 'Input text', 'text'),
  T('--t-on-primary', 'Text on primary', 'text', 'color', { description: 'Ink on filled primary buttons.' }),
  T('--t-muted', 'Muted (alias)', 'text', 'color', { alias: true }),
  T('--t-text', 'Text (alias)', 'text', 'color', { alias: true }),
  T('--t-heading', 'Heading (alias)', 'text', 'color', { alias: true }),
  T('--t-fg-muted', 'Foreground muted (alias)', 'text', 'color', { alias: true }),

  // Borders & edges
  T('--t-border', 'Border', 'borders'),
  T('--t-border-subtle', 'Border (subtle)', 'borders'),
  T('--t-edge-light', 'Edge light', 'borders'),
  T('--t-edge-mid', 'Edge mid', 'borders'),
  T('--t-edge-dark', 'Edge dark', 'borders'),
  T('--t-edge-darkest', 'Edge darkest', 'borders'),
  T('--t-tui-frame', 'Frame', 'borders', 'color', { description: 'ASCII-style frame lines.' }),
  T('--t-tui-user-frame', 'User frame', 'borders'),
  T('--t-tui-clara-frame', 'Assistant frame', 'borders'),
  T('--t-tui-input-frame', 'Input frame', 'borders'),

  // Interaction
  T('--t-hover-bg', 'Hover background', 'interaction'),
  T('--t-active-bg', 'Active background', 'interaction'),
  T('--t-selection-bg', 'Selection background', 'interaction'),
  T('--t-glow', 'Glow', 'interaction', 'color', { description: 'Accent glow; transparent for flat themes.' }),
  T('--t-glow-soft', 'Glow (soft)', 'interaction'),
  T('--t-elev-shadow', 'Elevation shadow', 'interaction', 'shadow'),

  // Chat bubbles
  T('--t-user-bg', 'User bubble background', 'chat'),
  T('--t-user-fg', 'User bubble text', 'chat'),
  T('--t-user-border', 'User bubble border', 'chat'),
  T('--t-assistant-bg', 'Assistant bubble background', 'chat'),
  T('--t-assistant-fg', 'Assistant bubble text', 'chat'),
  T('--t-assistant-border', 'Assistant bubble border', 'chat'),

  // Code
  T('--t-code-bg', 'Code block background', 'code'),
  T('--t-code-inline-bg', 'Inline code background', 'code'),
  T('--t-code-text', 'Code text', 'code'),

  // Syntax (highlight.js)
  T('--t-hljs-keyword', 'Keyword', 'syntax'),
  T('--t-hljs-string', 'String', 'syntax'),
  T('--t-hljs-number', 'Number', 'syntax'),
  T('--t-hljs-comment', 'Comment', 'syntax'),
  T('--t-hljs-function', 'Function', 'syntax'),
  T('--t-hljs-class', 'Class / type', 'syntax'),
  T('--t-hljs-attr', 'Attribute', 'syntax'),
  T('--t-hljs-params', 'Parameters', 'syntax'),
  T('--t-hljs-property', 'Property', 'syntax'),
  T('--t-hljs-punctuation', 'Punctuation', 'syntax'),
  T('--t-hljs-operator', 'Operator', 'syntax'),
  T('--t-hljs-meta', 'Meta', 'syntax'),
  T('--t-hljs-tag', 'Tag', 'syntax'),
  T('--t-hljs-name', 'Name', 'syntax'),
  T('--t-hljs-symbol', 'Symbol', 'syntax'),
  T('--t-hljs-selector', 'Selector', 'syntax'),

  // Status & decisions
  T('--t-confirm', 'Confirm', 'status', 'color', { description: 'Approve / accept decision buttons.' }),
  T('--t-caution', 'Caution', 'status', 'color', { description: 'Reject / risky decision buttons.' }),
  T('--t-log-level-error', 'Error', 'status'),
  T('--t-log-level-warning', 'Warning', 'status'),
  T('--t-process-a', 'Process indicator A', 'status'),
  T('--t-process-b', 'Process indicator B', 'status'),
  T('--t-process-c', 'Process indicator C', 'status'),
  T('--t-run-command-tab', 'Run-command tab', 'status'),
  T('--t-warn', 'Warn (alias)', 'status', 'color', { alias: true }),
  T('--t-danger', 'Danger (alias)', 'status', 'color', { alias: true }),
  T('--t-error', 'Error (alias)', 'status', 'color', { alias: true }),
  T('--t-success', 'Success (alias)', 'status', 'color', { alias: true }),

  // Typography
  T('--t-font', 'UI font stack', 'typography', 'font'),
  T('--t-font-mono', 'Monospace font stack', 'typography', 'font'),
  T('--t-mono', 'Monospace (alias)', 'typography', 'font', { alias: true }),
  T('--t-mono-font', 'Monospace font (alias)', 'typography', 'font', { alias: true }),

  // Title bar
  T('--t-titlebar-start', 'Title bar gradient start', 'titlebar'),
  T('--t-titlebar-end', 'Title bar gradient end', 'titlebar'),
  T('--t-titlebar-text', 'Title bar text', 'titlebar'),
];

export const THEME_TOKEN_NAMES: readonly string[] = THEME_TOKENS.map((t) => t.name);

const TOKEN_BY_NAME = new Map<string, ThemeTokenDef>();
for (const def of THEME_TOKENS) {
  TOKEN_BY_NAME.set(def.name, def);
}

export function themeTokenDef(name: string): ThemeTokenDef | undefined {
  return TOKEN_BY_NAME.get(name);
}

export function isThemeTokenName(name: unknown): name is string {
  return typeof name === 'string' && TOKEN_BY_NAME.has(name);
}

export function themeTokensInCategory(category: ThemeTokenCategoryId): ThemeTokenDef[] {
  return THEME_TOKENS.filter((t) => t.category === category);
}

/**
 * Runtime-only custom properties set inline by user preferences (fonts) rather than by a
 * theme. Excluded from the catalog-completeness check.
 */
export const THEME_RUNTIME_ONLY_PROPERTIES: readonly string[] = [
  '--t-font-ui-override',
  '--t-font-code-override',
];
