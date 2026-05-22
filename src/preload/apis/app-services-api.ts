import { ipcRenderer } from 'electron';
import type { AppConfig } from '../../shared';

/** App config, window chrome, scripts, and LLM server IPC. */
export const appServicesApi = {
  setAlwaysOnTop: (pinned: boolean) => ipcRenderer.invoke('set-always-on-top', pinned),
  loadConfig: () => ipcRenderer.invoke('load-config'),
  saveConfig: (config: unknown) => ipcRenderer.invoke('save-config', config),
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
  llamacppManagedListModels: (payload: { modelId: string; config: AppConfig }) =>
    ipcRenderer.invoke('llamacpp-managed:list-models', payload),
  llamacppOpenAiListModels: (payload: { baseUrl: string; apiKey: string }) =>
    ipcRenderer.invoke('llamacpp-openai:list-models', payload),
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
  popupFileMenu: (x: number, y: number) => ipcRenderer.invoke('popup-file-menu', x, y),
  popupHelpMenu: (x: number, y: number) => ipcRenderer.invoke('popup-help-menu', x, y),
  windowMinimize: () => ipcRenderer.send('window-minimize'),
  windowToggleMaximize: () => ipcRenderer.send('window-toggle-maximize'),
  windowClose: () => ipcRenderer.send('window-close'),
  windowIsMaximized: () => ipcRenderer.invoke('window-is-maximized') as Promise<boolean>,
  onWindowMaximizedChanged: (callback: (maximized: boolean) => void) => {
    ipcRenderer.on('window-maximized-changed', (_event, maximized: boolean) => callback(maximized));
  },
};
