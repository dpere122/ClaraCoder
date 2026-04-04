import { registerChatIpc } from './handlers/chat';
import { registerConfigWorkspacesIpc } from './handlers/config-workspaces';
import { registerAudioTtsIpc } from './handlers/audio-tts';
import { registerConversationsIpc } from './handlers/conversations';
import { registerFsIpc } from './handlers/fs-handlers';
import { registerScriptsIpc } from './handlers/scripts';

/** Registers all `ipcMain` handlers used by the preload `electronAPI` surface. */
export function registerAllIpc(): void {
  registerChatIpc();
  registerConfigWorkspacesIpc();
  registerAudioTtsIpc();
  registerConversationsIpc();
  registerFsIpc();
  registerScriptsIpc();
}
