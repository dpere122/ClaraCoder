import { registerChatIpc } from './handlers/chat';
import { registerConfigWorkspacesIpc } from './handlers/config-workspaces';
import { registerAudioTtsIpc } from './handlers/audio-tts';
import { openConversationsDb } from '../conversations-db';
import { registerConversationsIpc } from './handlers/conversations';
import { registerFsIpc } from './handlers/fs-handlers';
import { registerScriptsIpc } from './handlers/scripts';
import { registerWorkspacePtyIpc } from './handlers/workspace-pty';
import { registerWorkspaceWriteIpc } from './handlers/workspace-write';
import { registerHealthIpc } from './handlers/health';
import { registerHealthWindowIpc } from '../windows/health-window';
import { registerWindowChromeIpc } from './handlers/window-chrome';
import { registerLlamaServerIpc } from './handlers/llama-server';
import { registerLmStudioIpc } from './handlers/lm-studio';

/** Registers all `ipcMain` handlers used by the preload `electronAPI` surface. */
export function registerAllIpc(): void {
  openConversationsDb();
  registerChatIpc();
  registerLlamaServerIpc();
  registerLmStudioIpc();
  registerWindowChromeIpc();
  registerConfigWorkspacesIpc();
  registerAudioTtsIpc();
  registerConversationsIpc();
  registerFsIpc();
  registerScriptsIpc();
  registerWorkspacePtyIpc();
  registerWorkspaceWriteIpc();
  registerHealthIpc();
  registerHealthWindowIpc();
}
