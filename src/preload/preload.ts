/**
 * Preload script (isolated world): exposes a fixed `window.electronAPI` to the Angular app.
 * Uses contextBridge only — renderer never gets raw `ipcRenderer` except through these whitelisted calls.
 */
import { contextBridge } from 'electron';
import { appServicesApi } from './apis/app-services-api';
import { chatApi } from './apis/chat-api';
import { conversationApi } from './apis/conversation-api';
import { lspHealthApi } from './apis/lsp-health-api';
import { modelManagerApi } from './apis/model-manager-api';
import { workspaceApi } from './apis/workspace-api';
import { dependenciesApi } from './apis/dependencies-api';
import { themeApi } from './apis/theme-api';

contextBridge.exposeInMainWorld('electronAPI', {
  ...chatApi,
  ...workspaceApi,
  ...conversationApi,
  ...appServicesApi,
  ...modelManagerApi,
  ...lspHealthApi,
  ...dependenciesApi,
  ...themeApi,
});
