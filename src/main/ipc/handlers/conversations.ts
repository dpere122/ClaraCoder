import { ipcMain } from 'electron';
import { assertTrustedMainRenderer, assertTrustedMainRendererOrThrow } from '../assert-trusted-renderer';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import type { ConversationFile } from '../../../shared';
import { FIRST_THEME_ID } from '../../constants';
import { mainState } from '../../state';
import { ensurePythonReady } from '../../python/server';
import { pythonControlFetch } from '../../python/http-client';
import { getWorkspaceConversationsDir } from '../../paths';
import { syncConversationWorkspaceContext } from '../../workspace/watcher';
import {
  deleteConversationById,
  getConversationById,
  getConversationMetas,
  listChildConversationIds,
  markConversationsDeleted,
  updateAutoConversationTitle,
  updateConversationTheme,
  updateConversationTitleAndLock,
  upsertConversation,
} from '../../conversations-db';
import { pythonHistoryFromMessages } from '../../python-history';
import { abortChatStream, hasActiveChatStream } from './chat-stream-state';
import { forgetConversationRenderer } from './conversation-renderers';

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
  ipcMain.handle('get-conversations', async (event, workspaceId?: string | null) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      return [];
    }
    const ws = effectiveWorkspaceId(workspaceId);
    if (ws) {
      await fs.mkdir(getWorkspaceConversationsDir(ws), { recursive: true });
    }
    return getConversationMetas(ws);
  });

  ipcMain.handle('read-conversation-from-disk', async (event, id: string, _workspaceId?: string | null) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      throw new Error('Untrusted IPC sender');
    }
    const conv = getConversationById(id);
    if (!conv) {
      throw new Error('Conversation not found');
    }
    return conv;
  });

  ipcMain.handle(
    'load-conversation',
    async (
      event,
      id: string,
      _workspaceId?: string | null,
      options?: { skipPythonResync?: boolean },
    ) => {
      try {
        assertTrustedMainRenderer(event);
      } catch {
        throw new Error('Untrusted IPC sender');
      }
      // `/load` stops a running turn. Another window (or a bridge tab) opening a conversation
      // that is streaming does not know about that stream, so the check lives here.
      const skipPythonResync = Boolean(options?.skipPythonResync) || hasActiveChatStream(id);
      const conv = getConversationById(id);
      if (!conv) {
        throw new Error('Conversation not found');
      }
      if (conv.parentConversationId) {
        // A sub-agent conversation is only viewed. Its parent stays the active conversation, so
        // workspace and prompt syncs keep going to the session that can still take a turn, and
        // Python (which owns the sub-agent's live session) is not resynced.
        return conv;
      }

      mainState.activeConversationId = id;
      const sw = mainState.settingsWindow;
      if (sw && !sw.isDestroyed()) {
        sw.webContents.send('active-conversation-changed', id);
      }

      if (!skipPythonResync) {
        try {
          await syncConversationWorkspaceContext(conv);
        } catch (err) {
          console.error('Failed to sync workspace context:', err);
        }
      }

      if (!skipPythonResync) {
        try {
          await ensurePythonReady();
          await pythonControlFetch('/load', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: id, messages: pythonHistoryFromMessages(conv.messages) }),
          });
        } catch (err) {
          console.error('Failed to sync history with Python:', err);
        }
      }

      return conv;
    },
  );

  ipcMain.handle('save-conversation', async (event, conv: ConversationFile) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      return;
    }
    if (conv.workspaceId) {
      await fs.mkdir(getWorkspaceConversationsDir(conv.workspaceId), { recursive: true });
    }
    upsertConversation(conv);
  });

  ipcMain.handle('delete-conversation', async (event, id: string, _workspaceId?: string | null) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      return;
    }
    // Its sub-agent conversations go with it. Tombstone first so a save or a sub-agent row the
    // stream is still finishing cannot bring any of them back.
    const ids = [id, ...listChildConversationIds(id)];
    markConversationsDeleted(ids);
    if (hasActiveChatStream(id)) {
      await abortChatStream(id);
    }
    for (const sessionId of ids) {
      try {
        await ensurePythonReady();
        await pythonControlFetch('/dispose', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId }),
        });
      } catch (err) {
        console.error('Failed to dispose Python session:', err);
      }
    }
    deleteConversationById(id);
    for (const deletedId of ids) {
      forgetConversationRenderer(deletedId);
    }
  });

  ipcMain.handle('rename-conversation', async (event, id: string, title: string, _workspaceId?: string | null) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      return;
    }
    console.log('[Main] rename-conversation called:', { id, title, workspaceId: _workspaceId });
    const updatedAt = new Date().toISOString();
    updateConversationTitleAndLock(id, title, updatedAt);
    console.log('[Main] Rename successful (SQLite)');
  });

  ipcMain.handle('maybe-auto-title-conversation', async (event, id: string) => {
    try {
      assertTrustedMainRendererOrThrow(event);
    } catch {
      return { ok: false as const, reason: 'fetch_failed' as const };
    }
    const conv = getConversationById(id);
    if (!conv) {
      return { ok: false as const, reason: 'not_found' as const };
    }
    if (conv.customTitle || conv.parentConversationId) {
      // Sub-agent conversations keep the name the main agent gave them.
      return { ok: false as const, reason: 'locked' as const };
    }
    const n = assistantMessageCount(conv.messages);
    if (!shouldRunAutoTitle(n)) {
      return { ok: false as const, reason: 'not_due' as const };
    }
    try {
      const res = await pythonControlFetch('/conversation/suggest-title', {
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

  ipcMain.handle('new-conversation', async (event, workspaceId: string | null) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      throw new Error('Untrusted IPC sender');
    }
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

    // Persist first and return so the renderer spinner is not gated on Python.
    // After managed llama-server starts, the sidecar can sit on control routes until
    // undici's 60s headers timeout (`Failed to clear Python history` / New Conversation
    // overlay never clears). Skip POST /clear: this id is new (`get_session` creates an
    // empty session), and a late /clear can race the first chat turn and wipe it.
    void syncConversationWorkspaceContext(conv).catch((err) => {
      console.error('Failed to sync workspace context for new conversation:', err);
    });

    return conv;
  });

  ipcMain.handle('set-conversation-theme', async (event, id: string, themeId: string) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      return;
    }
    try {
      updateConversationTheme(id, themeId, new Date().toISOString());
    } catch (err) {
      console.error('Failed to update conversation theme:', err);
    }
  });

  ipcMain.handle('get-active-conversation-id', async (event) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      return null;
    }
    return mainState.activeConversationId;
  });
}
