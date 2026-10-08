/**
 * Preload script (isolated world): exposes a fixed `window.electronAPI` to the Angular app.
 * Uses contextBridge only — renderer never gets raw `ipcRenderer` except through these whitelisted calls.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { createAppServicesApi } from './apis/app-services-api';
import { createChatApi } from './apis/chat-api';
import { createConversationApi } from './apis/conversation-api';
import { createLspHealthApi } from './apis/lsp-health-api';
import { createModelManagerApi } from './apis/model-manager-api';
import { createWorkspaceApi } from './apis/workspace-api';
import { createDependenciesApi } from './apis/dependencies-api';
import { createThemeApi } from './apis/theme-api';

contextBridge.exposeInMainWorld('electronAPI', {
  ...createChatApi(ipcRenderer),
  ...createWorkspaceApi(ipcRenderer),
  ...createConversationApi(ipcRenderer),
  ...createAppServicesApi(ipcRenderer),
  ...createModelManagerApi(ipcRenderer),
  ...createLspHealthApi(ipcRenderer),
  ...createDependenciesApi(ipcRenderer),
  ...createThemeApi(ipcRenderer),
});
