/**
 * Preload script (isolated world): exposes a fixed `window.electronAPI` to the Angular app.
 * Uses contextBridge only — renderer never gets raw `ipcRenderer` except through these whitelisted calls.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { FileDiffPayload, TtsStreamPacket } from '../shared';

contextBridge.exposeInMainWorld('electronAPI', {
  onReady: () => ipcRenderer.send('ready'),
  onMessageChunk: (callback: (event: unknown, conversationId: string, delta: string) => void) =>
    ipcRenderer.on('message-chunk', callback),
  onMessageToolReadChunk: (callback: (event: unknown, conversationId: string, delta: string) => void) =>
    ipcRenderer.on('message-tool-read-chunk', callback),
  onMessageDone: (callback: (event: unknown, conversationId: string) => void) => ipcRenderer.on('message-done', callback),
  onMessageStatus: (callback: (event: unknown, conversationId: string, status: unknown) => void) =>
    ipcRenderer.on('message-status', callback),
  onMessageDiff: (callback: (event: unknown, conversationId: string, diff: FileDiffPayload) => void) =>
    ipcRenderer.on('message-diff', callback),
  sendMessage: (conversationId: string, msg: string, applyMode?: boolean, autoApplyMode?: boolean) =>
    ipcRenderer.send('message', conversationId, msg, applyMode ?? true, autoApplyMode ?? false),
  agentContinue: (conversationId: string, note: string) => ipcRenderer.invoke('agent-continue', conversationId, note),
  syncAutoApplyMode: (conversationId: string, autoApplyMode: boolean) =>
    ipcRenderer.invoke('sync-auto-apply-mode', conversationId, autoApplyMode),
  writeWorkspaceFile: (workspaceRoot: string, relativePath: string, utf8Content: string) =>
    ipcRenderer.invoke('write-workspace-file', workspaceRoot, relativePath, utf8Content),
  setAlwaysOnTop: (pinned: boolean) => ipcRenderer.invoke('set-always-on-top', pinned),
  getConversations: (workspaceId?: string | null) => ipcRenderer.invoke('get-conversations', workspaceId),
  loadConversation: (id: string, workspaceId?: string | null) => ipcRenderer.invoke('load-conversation', id, workspaceId),
  saveConversation: (conv: unknown) => ipcRenderer.invoke('save-conversation', conv),
  deleteConversation: (id: string, workspaceId?: string | null) => ipcRenderer.invoke('delete-conversation', id, workspaceId),
  renameConversation: (id: string, title: string, workspaceId?: string | null) =>
    ipcRenderer.invoke('rename-conversation', id, title, workspaceId),
  newConversation: (workspaceId: string | null) => ipcRenderer.invoke('new-conversation', workspaceId),
  startTtsStream: (text: string, voice: string, seq: number) =>
    ipcRenderer.invoke('tts-stream-start', { text, voice, seq }),
  registerTtsStreamUrl: (text: string, voice: string) =>
    ipcRenderer.invoke('tts-stream-register', { text, voice }),
  abortTtsStream: () => ipcRenderer.invoke('tts-stream-abort'),
  onTtsStreamPacket: (callback: (packet: TtsStreamPacket) => void) => {
    ipcRenderer.on('tts-stream-packet', (_event, packet) => callback(packet));
  },
  // Uint8Array survives Electron IPC structured clone more reliably than raw ArrayBuffer.
  transcribe: (audio: ArrayBuffer) => ipcRenderer.invoke('transcribe', new Uint8Array(audio)),
  openDirectoryDialog: () => ipcRenderer.invoke('open-directory-dialog'),
  readDirectory: (dirPath: string) => ipcRenderer.invoke('read-directory', dirPath),
  readDirectoryRecursive: (dirPath: string) => ipcRenderer.invoke('read-directory-recursive', dirPath),
  setWorkspaceContext: (sessionId: string, workspacePath: string, workspaceContext: string) =>
    ipcRenderer.invoke('set-workspace-context', sessionId, workspacePath, workspaceContext),
  loadConfig: () => ipcRenderer.invoke('load-config'),
  saveConfig: (config: unknown) => ipcRenderer.invoke('save-config', config),
  getWorkspaces: () => ipcRenderer.invoke('get-workspaces'),
  addWorkspace: (name: string, p: string) => ipcRenderer.invoke('add-workspace', name, p),
  removeWorkspace: (id: string) => ipcRenderer.invoke('remove-workspace', id),
  setCurrentWorkspace: (id: string | null) => ipcRenderer.invoke('set-current-workspace', id),
  getCurrentWorkspace: () => ipcRenderer.invoke('get-current-workspace'),
  setConversationTheme: (id: string, themeId: string) => ipcRenderer.invoke('set-conversation-theme', id, themeId),
  setWorkspaceTheme: (workspaceId: string, themeId: string) =>
    ipcRenderer.invoke('set-workspace-theme', workspaceId, themeId),
  setNoWorkspaceTheme: (themeId: string) => ipcRenderer.invoke('set-no-workspace-theme', themeId),
  getActiveConversationId: () => ipcRenderer.invoke('get-active-conversation-id'),
  onConfigUpdated: (callback: (event: unknown, config: unknown) => void) => ipcRenderer.on('config-updated', callback),
  onSettingsWindowVisibilityChanged: (callback: (event: unknown, isOpen: boolean) => void) =>
    ipcRenderer.on('settings-window-visibility-changed', callback),
  closeSettingsWindow: () => ipcRenderer.send('close-settings-window'),
  onActiveConversationChanged: (callback: (event: unknown, conversationId: string) => void) =>
    ipcRenderer.on('active-conversation-changed', callback),
  onConversationWorkspaceChanged: (callback: (event: unknown, data: { id: string; workspacePath: string }) => void) =>
    ipcRenderer.on('conversation-workspace-changed', callback),
  onWorkspaceChanged: (callback: (event: unknown, workspaceId: string | null) => void) =>
    ipcRenderer.on('workspace-changed', callback),
  onWorkspaceFilesChanged: (callback: (event: unknown, data: unknown) => void) =>
    ipcRenderer.on('workspace-files-changed', callback),
  onOpenWorkspace: (callback: (event: unknown, p: string) => void) => ipcRenderer.on('open-workspace', callback),
  onOpenConversation: (callback: (event: unknown, id: string) => void) => ipcRenderer.on('open-conversation', callback),
  runScript: (script: string, language: string, workspacePath: string) =>
    ipcRenderer.invoke('run-script', script, language, workspacePath),
  runScriptInteractive: (script: string, language: string, workspacePath: string) =>
    ipcRenderer.invoke('run-script-interactive', script, language, workspacePath),
  sendScriptInput: (processId: string, input: string) => ipcRenderer.invoke('send-script-input', processId, input),
  endScript: (processId: string) => ipcRenderer.invoke('end-script', processId),
  onScriptOutput: (callback: (event: unknown, data: unknown) => void) => ipcRenderer.on('script-output', callback),
  onScriptComplete: (callback: (event: unknown, data: unknown) => void) => ipcRenderer.on('script-complete', callback),
});
