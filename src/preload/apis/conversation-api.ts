import type { PreloadIpc } from '../preload-ipc';

/** Conversation persistence IPC. */
export const createConversationApi = (ipcRenderer: PreloadIpc) => ({
  getConversations: (workspaceId?: string | null) => ipcRenderer.invoke('get-conversations', workspaceId),
  readConversationFromDisk: (id: string, workspaceId?: string | null) =>
    ipcRenderer.invoke('read-conversation-from-disk', id, workspaceId),
  loadConversation: (id: string, workspaceId?: string | null, options?: { skipPythonResync?: boolean }) =>
    ipcRenderer.invoke('load-conversation', id, workspaceId, options),
  saveConversation: (conv: unknown) => ipcRenderer.invoke('save-conversation', conv),
  deleteConversation: (id: string, workspaceId?: string | null) => ipcRenderer.invoke('delete-conversation', id, workspaceId),
  renameConversation: (id: string, title: string, workspaceId?: string | null) =>
    ipcRenderer.invoke('rename-conversation', id, title, workspaceId),
  maybeAutoTitleConversation: (id: string) => ipcRenderer.invoke('maybe-auto-title-conversation', id),
  newConversation: (workspaceId: string | null) => ipcRenderer.invoke('new-conversation', workspaceId),
  setConversationTheme: (id: string, themeId: string) => ipcRenderer.invoke('set-conversation-theme', id, themeId),
  getActiveConversationId: () => ipcRenderer.invoke('get-active-conversation-id'),
  onActiveConversationChanged: (callback: (event: unknown, conversationId: string) => void) =>
    ipcRenderer.on('active-conversation-changed', callback),
  onConversationWorkspaceChanged: (callback: (event: unknown, data: { id: string; workspacePath: string }) => void) =>
    ipcRenderer.on('conversation-workspace-changed', callback),
  onOpenConversation: (callback: (event: unknown, id: string) => void) => ipcRenderer.on('open-conversation', callback),
  listConversationFileJournal: (conversationId: string) =>
    ipcRenderer.invoke('list-conversation-file-journal', conversationId),
  appendConversationFileJournal: (entry: unknown) => ipcRenderer.invoke('append-conversation-file-journal', entry),
  restoreConversationTimeline: (request: unknown) => ipcRenderer.invoke('restore-conversation-timeline', request),
});
