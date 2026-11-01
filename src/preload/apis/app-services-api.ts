import type { PreloadIpc } from '../preload-ipc';
import type { ScreenshotAssetStatus, ScreenshotStorageStats } from '../../shared/screenshot-retention';
import type {
  AppConfig,
  HealthMonitorConfig,
  MenuFileCommand,
  SystemFontInfo,
  WorkspaceMonacoEditorScrollState,
  WorkspaceOpenTabsState,
} from '../../shared';

type ScreenshotStorageResult = { ok: true; stats: ScreenshotStorageStats } | { ok: false; error: string };

/** App config, window chrome, scripts, and LLM server IPC. */
export const createAppServicesApi = (ipcRenderer: PreloadIpc) => ({
  setAlwaysOnTop: (pinned: boolean) => ipcRenderer.invoke('set-always-on-top', pinned),
  loadConfig: () => ipcRenderer.invoke('load-config'),
  saveConfig: (config: unknown) => ipcRenderer.invoke('save-config', config),
  getScreenshotStorageStats: (): Promise<ScreenshotStorageResult> => ipcRenderer.invoke('screenshot-storage-stats'),
  runScreenshotCleanup: (): Promise<ScreenshotStorageResult> => ipcRenderer.invoke('screenshot-cleanup'),
  clearScreenshots: (): Promise<ScreenshotStorageResult> => ipcRenderer.invoke('screenshot-clear'),
  getScreenshotAssetStatus: (url: string): Promise<ScreenshotAssetStatus> =>
    ipcRenderer.invoke('screenshot-asset-status', url),
  onScreenshotAssetsChanged: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on('screenshot-assets-changed', listener);
    return () => { ipcRenderer.removeListener('screenshot-assets-changed', listener); };
  },
  /** App-wide UI theme (single `AppConfig.themeId`, no per-workspace override). */
  setTheme: (themeId: string) => ipcRenderer.invoke('set-theme', themeId),
  setLastActiveConversation: (workspaceKey: string, conversationId: string) =>
    ipcRenderer.invoke('set-last-active-conversation', workspaceKey, conversationId),
  patchWorkspaceMonacoScroll: (
    workspaceId: string,
    relativePath: string,
    scroll: WorkspaceMonacoEditorScrollState | null,
  ) => ipcRenderer.invoke('patch-workspace-monaco-scroll', workspaceId, relativePath, scroll),
  patchWorkspaceOpenTabs: (workspaceId: string, state: WorkspaceOpenTabsState | null) =>
    ipcRenderer.invoke('patch-workspace-open-tabs', workspaceId, state),
  setActiveLlmModel: (modelId: string) => ipcRenderer.invoke('set-active-llm-model', modelId),
  patchHealthMonitor: (patch: Partial<HealthMonitorConfig>) => ipcRenderer.invoke('patch-health-monitor', patch),
  /** Client-only UI preference; main mutates just this key so other windows' saves survive. */
  setConfirmMove: (enabled: boolean) => ipcRenderer.invoke('set-confirm-move', enabled),
  onConfigUpdated: (callback: (event: unknown, config: unknown) => void) => ipcRenderer.on('config-updated', callback),
  onSettingsWindowVisibilityChanged: (callback: (event: unknown, isOpen: boolean) => void) =>
    ipcRenderer.on('settings-window-visibility-changed', callback),
  runScript: (script: string, language: string, workspacePath: string) =>
    ipcRenderer.invoke('run-script', script, language, workspacePath),
  runScriptInteractive: (script: string, language: string, workspacePath: string) =>
    ipcRenderer.invoke('run-script-interactive', script, language, workspacePath),
  sendScriptInput: (processId: string, input: string) => ipcRenderer.invoke('send-script-input', processId, input),
  endScript: (processId: string) => ipcRenderer.invoke('end-script', processId),
  onScriptOutput: (callback: (event: unknown, data: unknown) => void) => ipcRenderer.on('script-output', callback),
  onScriptComplete: (callback: (event: unknown, data: unknown) => void) => ipcRenderer.on('script-complete', callback),
  llamaServerStart: (payload: { modelId: string; config: AppConfig }) => ipcRenderer.invoke('llama-server:start', payload),
  llamaServerStop: (payload: { modelId: string; config: AppConfig }) => ipcRenderer.invoke('llama-server:stop', payload),
  llamaServerStatus: (payload: { modelId: string; config: AppConfig }) =>
    ipcRenderer.invoke('llama-server:status', payload),
  embeddingsStatus: () => ipcRenderer.invoke('embeddings:status'),
  mcpStatus: () => ipcRenderer.invoke('mcp:status'),
  mcpOauthStart: (serverId: string) => ipcRenderer.invoke('mcp:oauth-start', serverId),
  mcpRememberDecision: (payload: { serverId: string; decision: 'allow' | 'deny' | 'allow-all'; toolName?: string }) =>
    ipcRenderer.invoke('mcp:remember-decision', payload),
  llamaServerChatTemplateReasoning: (payload: { modelId: string }) =>
    ipcRenderer.invoke('llama-server:chat-template-reasoning', payload),
  llamacppManagedListModels: (payload: { modelId: string; config: AppConfig }) =>
    ipcRenderer.invoke('llamacpp-managed:list-models', payload),
  llamacppOpenAiListModels: (payload: { baseUrl: string; apiKey: string }) =>
    ipcRenderer.invoke('llamacpp-openai:list-models', payload),
  openRouterListModels: (payload: { baseUrl: string; apiKey: string }) =>
    ipcRenderer.invoke('openrouter:list-models', payload),
  /** Claude: the key goes in once and never comes back out; status carries only a hint. */
  anthropicStatus: (payload?: { refresh?: boolean }) => ipcRenderer.invoke('anthropic:status', payload),
  anthropicSetApiKey: (payload: { apiKey: string }) => ipcRenderer.invoke('anthropic:set-api-key', payload),
  anthropicClearApiKey: () => ipcRenderer.invoke('anthropic:clear-api-key'),
  anthropicSetModel: (payload: { modelId: string }) => ipcRenderer.invoke('anthropic:set-model', payload),
  lmStudioListModels: (payload: { baseUrl: string; apiKey?: string }) => ipcRenderer.invoke('lm-studio:list-models', payload),
  lmStudioLoadModel: (payload: { baseUrl: string; model: string; apiKey?: string }) =>
    ipcRenderer.invoke('lm-studio:load-model', payload),
  lmStudioUnloadModel: (payload: { baseUrl: string; instanceId: string; apiKey?: string }) =>
    ipcRenderer.invoke('lm-studio:unload-model', payload),
  onLlamaServerOutput: (callback: (event: unknown, data: unknown) => void) =>
    ipcRenderer.on('llama-server-output', callback),
  onLlamaServerProcessExit: (callback: (event: unknown, data: unknown) => void) =>
    ipcRenderer.on('llama-server-process-exit', callback),
  onLlamaServerLifecycle: (callback: (event: unknown, data: unknown) => void) =>
    ipcRenderer.on('llama-server-lifecycle', callback),
  openSettingsWindow: (tab?: string) => ipcRenderer.send('open-settings-window', tab),
  onSettingsSelectTab: (callback: (event: unknown, tab: string) => void) =>
    ipcRenderer.on('settings-select-tab', callback),
  notifySettingsWindowReady: () => ipcRenderer.send('settings-window-ready'),
  openDocumentation: () => ipcRenderer.send('open-documentation'),
  windowMinimize: () => ipcRenderer.send('window-minimize'),
  windowToggleMaximize: () => ipcRenderer.send('window-toggle-maximize'),
  windowClose: () => ipcRenderer.send('window-close'),
  appQuit: () => ipcRenderer.send('app-quit'),
  windowIsMaximized: () => ipcRenderer.invoke('window-is-maximized') as Promise<boolean>,
  listSystemFonts: () => ipcRenderer.invoke('list-system-fonts') as Promise<SystemFontInfo[]>,
  onWindowMaximizedChanged: (callback: (maximized: boolean) => void) => {
    ipcRenderer.on('window-maximized-changed', (_event, maximized: boolean) => callback(maximized));
  },
  /** Main stole Ctrl/Cmd+F from Chromium; renderer should open Monaco find when appropriate. */
  onEditorFindRequested: (callback: () => void) => {
    ipcRenderer.on('editor-find-requested', () => callback());
  },
  onMenuFileCommand: (callback: (command: MenuFileCommand) => void) => {
    ipcRenderer.on('menu-file-command', (_event, command: MenuFileCommand) => callback(command));
  },
});
