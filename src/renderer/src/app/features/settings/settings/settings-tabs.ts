/** Settings window tab ids and sub-tab catalog. */
import { THEME_GROUP_CATEGORIES } from '@shared/theme';
import { SETTINGS_TAB_ENTRIES, isSettingsTab, type SettingsTab } from '@shared/settings-tabs';

export { isSettingsTab, type SettingsTab };

export type SettingsSubTabEntry = {
  id: string;
  label: string;
  description: string;
};

const SETTINGS_TAB_DESCRIPTIONS: Record<SettingsTab, string> = {
  general: 'Chat font size, app fonts, and other global preferences.',
  themes:
    'Pick, create, import, and customize app themes: global colors, per-element-group overrides, background images, and the editor palette.',
  models: 'Chat sources, model defaults, and Start.',
  modelManager: 'Local models and Hugging Face search for managed llama-server.',
  tools: 'Workspace agent tool limits and edit modes (synced to the Python backend).',
  mcp: 'MCP servers whose tools Clara can call. One client, many server configs.',
  monaco:
    'Monaco options for the in-app workspace file editor (color theme, font, minimap, wrap, cursor, and editing behavior).',
  audio: 'Transcription, talk-mode microphone, Kokoro assistant voice, speech speed, and end-of-speech timing.',
  workspaces: 'Attached folders and active project.',
};

export const SETTINGS_TABS: Array<{ id: SettingsTab; label: string; description: string }> = SETTINGS_TAB_ENTRIES.map(
  (tab) => ({ ...tab, description: SETTINGS_TAB_DESCRIPTIONS[tab.id] }),
);

/** Reads `tab=` from an Angular hash URL (`#/settings?tab=general`). */
export function settingsTabFromHash(hash: string): SettingsTab | null {
  const trimmed = hash.startsWith('#') ? hash.slice(1) : hash;
  const queryStart = trimmed.indexOf('?');
  if (queryStart < 0) {
    return null;
  }
  const tab = new URLSearchParams(trimmed.slice(queryStart + 1)).get('tab');
  return isSettingsTab(tab) ? tab : null;
}

/** Pane to show on first paint: hash `tab=` when valid, otherwise Models. */
export function initialSettingsTab(hash = globalThis.location?.hash ?? ''): SettingsTab {
  return settingsTabFromHash(hash) ?? 'models';
}

/** Sub-tab id prefix for one registry category inside the Themes tab (`cat:chat`, `cat:editor`, …). */
export const THEMES_CATEGORY_SUB_TAB_PREFIX = 'cat:';

export function themesCategorySubTabId(categoryId: string): string {
  return `${THEMES_CATEGORY_SUB_TAB_PREFIX}${categoryId}`;
}

export function themesCategoryFromSubTabId(subTabId: string): string | null {
  return subTabId.indexOf(THEMES_CATEGORY_SUB_TAB_PREFIX) === 0
    ? subTabId.slice(THEMES_CATEGORY_SUB_TAB_PREFIX.length)
    : null;
}

/** Themes sub-tabs: library, global tokens, one pane per registered element-group category, editor palette, advanced. */
export function buildThemesSubTabs(
  categories: ReadonlyArray<{ id: string; label: string }> = THEME_GROUP_CATEGORIES,
): SettingsSubTabEntry[] {
  return [
    { id: 'library', label: 'Theme library', description: 'Choose the active theme; create, duplicate, import, export, or delete themes.' },
    { id: 'global', label: 'Global colors', description: 'Design tokens every element group inherits by default.' },
    ...categories.map((c) => ({
      id: themesCategorySubTabId(c.id),
      label: c.label,
      description: `Per-group token overrides, advanced CSS, and background images for ${c.label.toLowerCase()} elements.`,
    })),
    { id: 'monaco', label: 'Editor palette', description: 'Monaco colors and syntax rules; derived from the tokens unless customized.' },
    { id: 'advanced', label: 'Advanced', description: 'Theme metadata, raw JSON, and validation messages.' },
  ];
}

export const SETTINGS_SUB_TAB_CATALOG: Partial<Record<SettingsTab, SettingsSubTabEntry[]>> = {
  general: [
    {
      id: 'chat',
      label: 'Chat appearance',
      description:
        'App UI scale, chat font size, expanded chat width, app-wide UI font, and code font for message text.',
    },
  ],
  themes: buildThemesSubTabs(),
  tools: [
    {
      id: 'editTools',
      label: 'Edit tools',
      description:
        'File-edit tool mode and workspace exposure when Editor mode is on in the chat toolbar.',
    },
    {
      id: 'limits',
      label: 'Read & search limits',
      description: 'Caps how much one read or search tool call can return.',
    },
    {
      id: 'compression',
      label: 'Context compression',
      description:
        'Shortens older tool result bodies in the LangGraph checkpoint when usage exceeds the trigger threshold.',
    },
    {
      id: 'encoding',
      label: 'Encoding & newlines',
      description:
        'Default encoding and newline style when the model omits them on read, search, and edit tools.',
    },
  ],
  monaco: [
    {
      id: 'theme',
      label: 'Color theme',
      description:
        'Monaco color theme for workspace files. VS Dark is the default; VS Light and high-contrast themes are also available.',
    },
    {
      id: 'typography',
      label: 'Typography',
      description: 'Font size, line height, and optional font family. Leave family empty for the app monospace stack.',
    },
    {
      id: 'wrapMinimap',
      label: 'Wrap & minimap',
      description: 'Word wrap mode, wrap column, and minimap visibility and behavior.',
    },
    {
      id: 'display',
      label: 'Display',
      description: 'Scrolling, whitespace, line numbers, folding, and editor padding.',
    },
    {
      id: 'guides',
      label: 'Guides & indent',
      description: 'Indent and bracket guides, tab size, and space-vs-tab behavior.',
    },
    {
      id: 'cursor',
      label: 'Cursor',
      description: 'Cursor blink animation, shape, and width (0 = default).',
    },
    {
      id: 'editing',
      label: 'Editing',
      description: 'Formatting, auto-close pairs, and IntelliSense-style suggestions.',
    },
  ],
  audio: [
    {
      id: 'provider',
      label: 'Provider',
      description: 'Local Whisper or OpenAI-compatible transcription, or turn it off.',
    },
    {
      id: 'endpoint',
      label: 'Endpoint',
      description: 'Remote transcription base URL and API key (OpenAI-compatible provider).',
    },
    {
      id: 'capture',
      label: 'Voice capture',
      description: 'Talk-mode microphone and end-of-speech silence timing.',
    },
    {
      id: 'tts',
      label: 'Assistant voice',
      description: 'Kokoro (local) or OpenAI-compatible remote TTS for spoken assistant replies.',
    },
  ],
};
