/** Settings window tab ids and sub-tab catalog. */

export type SettingsTab = 'general' | 'models' | 'modelManager' | 'tools' | 'monaco' | 'audio' | 'workspaces';

export type SettingsSubTabEntry = {
  id: string;
  label: string;
  description: string;
};

export const SETTINGS_TABS: Array<{ id: SettingsTab; label: string; description: string }> = [
  {
    id: 'general',
    label: 'General',
    description: 'UI theme, chat font size, and other global preferences.',
  },
  {
    id: 'models',
    label: 'Models',
    description:
      'Pick a Model Manager GGUF or HF id on the local llama-server source, apply ready defaults, and Start. LM Studio and remote URL remain available.',
  },
  {
    id: 'modelManager',
    label: 'Model Manager',
    description: 'Local models and Hugging Face search for managed llama-server.',
  },
  {
    id: 'tools',
    label: 'Tools',
    description: 'Workspace agent tool limits and edit modes (synced to the Python backend).',
  },
  {
    id: 'monaco',
    label: 'Editor',
    description: 'Monaco options for the in-app workspace file editor (color theme, font, minimap, wrap, cursor, and editing behavior).',
  },
  { id: 'audio', label: 'Audio', description: 'Transcription, talk-mode microphone, Kokoro assistant voice, speech speed, and end-of-speech timing.' },
  { id: 'workspaces', label: 'Workspaces', description: 'Attached folders and active project.' },
];

export const SETTINGS_SUB_TAB_CATALOG: Partial<Record<SettingsTab, SettingsSubTabEntry[]>> = {
  general: [
    {
      id: 'themes',
      label: 'Theme',
      description: 'App-wide UI theme.',
    },
    {
      id: 'chat',
      label: 'Chat appearance',
      description:
        'App UI scale, chat font size, expanded chat width, app-wide UI font, and code font for message text.',
    },
  ],
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
        'Monaco color theme for workspace files. Clara tracks the app code colors; VS and high-contrast themes are built-ins.',
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
      description: 'Enable transcription or turn it off completely.',
    },
    {
      id: 'endpoint',
      label: 'Endpoint',
      description: 'OpenAI-compatible transcription base URL, model name, and API key.',
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
