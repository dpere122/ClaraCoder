/**
 * Settings window categories, in menu order. The single list behind the titlebar Settings
 * dropdown, the native Settings menu, and the main-process `open-settings-window` tab check.
 */
export const SETTINGS_TAB_ENTRIES = [
  { id: 'general', label: 'General' },
  { id: 'themes', label: 'Themes' },
  { id: 'models', label: 'Models' },
  { id: 'modelManager', label: 'Model Manager' },
  { id: 'tools', label: 'Tools' },
  { id: 'mcp', label: 'MCP' },
  { id: 'monaco', label: 'Editor' },
  { id: 'audio', label: 'Audio' },
  { id: 'workspaces', label: 'Workspaces' },
] as const;

export type SettingsTab = (typeof SETTINGS_TAB_ENTRIES)[number]['id'];

export function isSettingsTab(value: unknown): value is SettingsTab {
  return typeof value === 'string' && SETTINGS_TAB_ENTRIES.some((tab) => tab.id === value);
}
