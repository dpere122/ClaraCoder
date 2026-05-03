import { ipcMain } from 'electron';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import type {
  ChatStructuredContentPart,
  ConversationFile,
  ConversationFileMessage,
} from '../../../shared';
import { FIRST_THEME_ID } from '../../constants';
import { mainState } from '../../state';
import { PYTHON_URL } from '../../python/server';
import { getWorkspaceConversationsDir } from '../../paths';
import { syncConversationWorkspaceContext } from '../../workspace/watcher';
import {
  deleteConversationById,
  getConversationById,
  getConversationMetas,
  updateConversationTheme,
  updateConversationTitle,
  upsertConversation,
} from '../../conversations-db';

type UserChatRow = Extract<ConversationFileMessage, { role: 'user' }>;

/** Map a saved user row to Python session history (plain string or OpenAI-style multimodal list). */
function userMessageToPythonHistoryEntry(m: UserChatRow): { role: 'user'; content: string | Record<string, unknown>[] } {
  const sc = m.structuredContent;
  if (sc && sc.length > 0) {
    const blocks = sc.map((b: ChatStructuredContentPart) => ({ ...b }));
    const hasText = blocks.some(
      (b: Record<string, unknown>) =>
        String(b['type'] ?? '').toLowerCase() === 'text' && String((b as { text?: string }).text ?? '').trim(),
    );
    if (m.text.trim() && !hasText) {
      blocks.unshift({ type: 'text', text: m.text });
    }
    return { role: 'user', content: blocks };
  }
  return { role: 'user', content: m.text };
}

function effectiveWorkspaceId(workspaceId?: string | null): string | null {
  return typeof workspaceId === 'string' && workspaceId.length > 0 ? workspaceId : null;
}

/**
 * Conversation persistence (SQLite), Python session sync (`/clear`, `/load`), and theme tweaks.
 */
export function registerConversationsIpc(): void {
  ipcMain.handle('get-conversations', async (_event, workspaceId?: string | null) => {
    const ws = effectiveWorkspaceId(workspaceId);
    if (ws) {
      await fs.mkdir(getWorkspaceConversationsDir(ws), { recursive: true });
    }
    return getConversationMetas(ws);
  });

  ipcMain.handle('read-conversation-from-disk', async (_event, id: string, _workspaceId?: string | null) => {
    const conv = getConversationById(id);
    if (!conv) {
      throw new Error('Conversation not found');
    }
    return conv;
  });

  ipcMain.handle(
    'load-conversation',
    async (
      _event,
      id: string,
      _workspaceId?: string | null,
      options?: { skipPythonResync?: boolean },
    ) => {
      const skipPythonResync = Boolean(options?.skipPythonResync);
      mainState.activeConversationId = id;

      const sw = mainState.settingsWindow;
      if (sw && !sw.isDestroyed()) {
        sw.webContents.send('active-conversation-changed', id);
      }

      const conv = getConversationById(id);
      if (!conv) {
        throw new Error('Conversation not found');
      }

      if (!skipPythonResync) {
        try {
          await fetch(`${PYTHON_URL}/clear`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: id }),
          });
        } catch (err) {
          console.error('Failed to reset Python session before loading conversation:', err);
        }
      }

      try {
        await syncConversationWorkspaceContext(conv);
      } catch (err) {
        console.error('Failed to sync workspace context:', err);
      }

      if (!skipPythonResync) {
        type PyHistoryMsg =
          | { role: 'user'; content: string | Record<string, unknown>[] }
          | { role: 'assistant'; content: string };
        const pyMessages: PyHistoryMsg[] = [];
        for (const m of conv.messages) {
          if (m.role === 'user') {
            pyMessages.push(userMessageToPythonHistoryEntry(m));
          } else if (m.role === 'assistant') {
            pyMessages.push({ role: 'assistant', content: m.text });
          }
        }
        try {
          await fetch(`${PYTHON_URL}/load`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: id, messages: pyMessages }),
          });
        } catch (err) {
          console.error('Failed to sync history with Python:', err);
        }
      }

      return conv;
    },
  );

  ipcMain.handle('save-conversation', async (_event, conv: ConversationFile) => {
    if (conv.workspaceId) {
      await fs.mkdir(getWorkspaceConversationsDir(conv.workspaceId), { recursive: true });
    }
    upsertConversation(conv);
  });

  ipcMain.handle('delete-conversation', async (_event, id: string, _workspaceId?: string | null) => {
    deleteConversationById(id);
  });

  ipcMain.handle('rename-conversation', async (_event, id: string, title: string, _workspaceId?: string | null) => {
    console.log('[Main] rename-conversation called:', { id, title, workspaceId: _workspaceId });
    const updatedAt = new Date().toISOString();
    updateConversationTitle(id, title, updatedAt);
    console.log('[Main] Rename successful (SQLite)');
  });

  ipcMain.handle('new-conversation', async (_event, workspaceId: string | null) => {
    const id = randomUUID();
    mainState.activeConversationId = id;
    mainState.activeConversationWorkspaceId = workspaceId;

    const settingsWin = mainState.settingsWindow;
    if (settingsWin && !settingsWin.isDestroyed()) {
      settingsWin.webContents.send('active-conversation-changed', id);
    }

    const now = new Date().toISOString();
    const conv: ConversationFile = {
      id,
      title: 'New Conversation',
      createdAt: now,
      updatedAt: now,
      messages: [],
      workspaceId,
      themeId: FIRST_THEME_ID,
    };

    if (workspaceId) {
      await fs.mkdir(getWorkspaceConversationsDir(workspaceId), { recursive: true });
    }
    upsertConversation(conv);

    try {
      await fetch(`${PYTHON_URL}/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: id }),
      });
    } catch (err) {
      console.error('Failed to clear Python history:', err);
    }

    try {
      await syncConversationWorkspaceContext(conv);
    } catch (err) {
      console.error('Failed to sync workspace context for new conversation:', err);
    }

    return conv;
  });

  ipcMain.handle('set-conversation-theme', async (_event, id: string, themeId: string) => {
    try {
      updateConversationTheme(id, themeId, new Date().toISOString());
    } catch (err) {
      console.error('Failed to update conversation theme:', err);
    }
  });

  ipcMain.handle('get-active-conversation-id', async () => mainState.activeConversationId);
}
