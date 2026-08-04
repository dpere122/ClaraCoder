import { ipcMain } from 'electron';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import type { ConversationFile } from '../../../shared';
import { FIRST_THEME_ID } from '../../constants';
import { mainState } from '../../state';
import { ensurePythonReady, PYTHON_URL } from '../../python/server';
import { getWorkspaceConversationsDir } from '../../paths';
import { syncConversationWorkspaceContext } from '../../workspace/watcher';
import {
  deleteConversationById,
  getConversationById,
  getConversationMetas,
  updateAutoConversationTitle,
  updateConversationTheme,
  updateConversationTitleAndLock,
  upsertConversation,
} from '../../conversations-db';

function assistantMessageCount(messages: ConversationFile['messages']): number {
  return messages.filter((m) => m.role === 'assistant').length;
}

/** Keep in sync with `clara_coder_backend.conversation_title_cadence.should_refresh_auto_title`. */
function shouldRunAutoTitle(assistantCount: number): boolean {
  return assistantCount === 1 || (assistantCount > 0 && assistantCount % 25 === 0);
}

function effectiveWorkspaceId(workspaceId?: string | null): string | null {
  return typeof workspaceId === 'string' && workspaceId.length > 0 ? workspaceId : null;
}

/**
 * Conversation persistence (SQLite), Python session sync (`/load`), and theme tweaks.
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
          await syncConversationWorkspaceContext(conv);
        } catch (err) {
          console.error('Failed to sync workspace context:', err);
        }
      }

      if (!skipPythonResync) {
        type PyHistoryMsg =
          | { role: 'user'; message: string; structuredContent?: readonly Record<string, unknown>[] }
          | { role: 'assistant'; content: string };
        const pyMessages: PyHistoryMsg[] = [];
        for (const m of conv.messages) {
          if (m.role === 'user') {
            pyMessages.push({
              role: 'user',
              message: m.text,
              ...(m.structuredContent?.length ? { structuredContent: m.structuredContent } : {}),
            });
          } else if (m.role === 'assistant') {
            pyMessages.push({ role: 'assistant', content: m.text });
          }
        }
        try {
          await ensurePythonReady();
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
    try {
      await ensurePythonReady();
      await fetch(`${PYTHON_URL}/dispose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: id }),
      });
    } catch (err) {
      console.error('Failed to dispose Python session:', err);
    }
    deleteConversationById(id);
  });

  ipcMain.handle('rename-conversation', async (_event, id: string, title: string, _workspaceId?: string | null) => {
    console.log('[Main] rename-conversation called:', { id, title, workspaceId: _workspaceId });
    const updatedAt = new Date().toISOString();
    updateConversationTitleAndLock(id, title, updatedAt);
    console.log('[Main] Rename successful (SQLite)');
  });

  ipcMain.handle('maybe-auto-title-conversation', async (_event, id: string) => {
    const conv = getConversationById(id);
    if (!conv) {
      return { ok: false as const, reason: 'not_found' as const };
    }
    if (conv.customTitle) {
      return { ok: false as const, reason: 'locked' as const };
    }
    const n = assistantMessageCount(conv.messages);
    if (!shouldRunAutoTitle(n)) {
      return { ok: false as const, reason: 'not_due' as const };
    }
    try {
      const res = await fetch(`${PYTHON_URL}/conversation/suggest-title`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: id }),
      });
      if (!res.ok) {
        console.error('[Main] maybe-auto-title: Python returned', res.status);
        return { ok: false as const, reason: 'python_error' as const };
      }
      const data = (await res.json()) as { title?: string };
      const raw = (data.title ?? '').trim().replace(/\s+/g, ' ');
      const safe = raw.replace(/[\r\n]+/g, ' ').slice(0, 120);
      if (!safe) {
        return { ok: false as const, reason: 'empty_title' as const };
      }
      const updatedAt = new Date().toISOString();
      const changed = updateAutoConversationTitle(id, safe, updatedAt);
      if (!changed) {
        return { ok: false as const, reason: 'locked' as const };
      }
      return { ok: true as const, title: safe, updatedAt };
    } catch (err) {
      console.error('[Main] maybe-auto-title failed:', err);
      return { ok: false as const, reason: 'fetch_failed' as const };
    }
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
      customTitle: false,
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
