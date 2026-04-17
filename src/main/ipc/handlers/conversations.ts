import { ipcMain } from 'electron';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path = require('path');
import type {
  ChatStructuredContentPart,
  ConversationFile,
  ConversationFileMessage,
  ConversationMeta,
} from '../../../shared';
import { FIRST_THEME_ID } from '../../constants';
import { mainState } from '../../state';
import { loadConfig } from '../../config/load-save';
import { PYTHON_URL } from '../../python/server';
import {
  getGeneralConversationsDir,
  getWorkspaceConversationsDir,
} from '../../paths';
import { syncConversationWorkspaceContext } from '../../workspace/watcher';

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

async function findConversationPath(id: string, workspaceId: string | null): Promise<string | null> {
  if (workspaceId) {
    const wsDir = getWorkspaceConversationsDir(workspaceId);
    try {
      const wsPath = path.join(wsDir, `${id}.json`);
      await fs.access(wsPath);
      console.log('[Main] findConversationPath: found in workspace dir:', wsPath);
      return wsPath;
    } catch {
      console.log('[Main] findConversationPath: not in workspace dir:', wsDir);
    }
  }

  const legacyDir = getGeneralConversationsDir();
  try {
    const legacyPath = path.join(legacyDir, `${id}.json`);
    await fs.access(legacyPath);
    console.log('[Main] findConversationPath: found in legacy dir:', legacyPath);
    return legacyPath;
  } catch {
    console.log('[Main] findConversationPath: not in legacy dir:', legacyDir);
  }

  const config = await loadConfig();
  for (const workspace of config.workspaces) {
    if (workspace.id === workspaceId) continue;
    const wsDir = getWorkspaceConversationsDir(workspace.id);
    try {
      const wsPath = path.join(wsDir, `${id}.json`);
      await fs.access(wsPath);
      console.log('[Main] findConversationPath: found while scanning workspaces:', wsPath);
      return wsPath;
    } catch {
      // continue scanning
    }
  }

  return null;
}

/**
 * Conversation JSON on disk, Python session sync (`/clear`, `/load`), and theme tweaks.
 */
export function registerConversationsIpc(): void {
  ipcMain.handle('get-conversations', async (_event, workspaceId?: string | null) => {
    if (workspaceId) {
      const dir = getWorkspaceConversationsDir(workspaceId);
      await fs.mkdir(dir, { recursive: true });
      const files = await fs.readdir(dir);
      const metas: ConversationMeta[] = [];
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = await fs.readFile(path.join(dir, file), 'utf-8');
          const conv: ConversationFile = JSON.parse(raw) as ConversationFile;
          metas.push({
            id: conv.id,
            title: conv.title,
            createdAt: conv.createdAt,
            updatedAt: conv.updatedAt,
            workspaceId: conv.workspaceId,
          });
        } catch {
          // skip malformed files
        }
      }
      metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return metas;
    }

    const allMetas: ConversationMeta[] = [];
    const generalDir = getGeneralConversationsDir();
    try {
      const files = await fs.readdir(generalDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = await fs.readFile(path.join(generalDir, file), 'utf-8');
          const conv: ConversationFile = JSON.parse(raw) as ConversationFile;
          allMetas.push({
            id: conv.id,
            title: conv.title,
            createdAt: conv.createdAt,
            updatedAt: conv.updatedAt,
            workspaceId: null,
          });
        } catch {
          // skip malformed files
        }
      }
    } catch {
      // General dir might not exist yet
    }

    allMetas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return allMetas;
  });

  ipcMain.handle('load-conversation', async (_event, id: string, workspaceId?: string | null) => {
    mainState.activeConversationId = id;

    const sw = mainState.settingsWindow;
    if (sw && !sw.isDestroyed()) {
      sw.webContents.send('active-conversation-changed', id);
    }

    const filePath = await findConversationPath(id, workspaceId ?? null);
    if (!filePath) {
      throw new Error('Conversation not found');
    }

    const raw = await fs.readFile(filePath, 'utf-8');
    const conv: ConversationFile = JSON.parse(raw) as ConversationFile;

    try {
      await fetch(`${PYTHON_URL}/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: id }),
      });
    } catch (err) {
      console.error('Failed to reset Python session before loading conversation:', err);
    }

    try {
      await syncConversationWorkspaceContext(conv);
    } catch (err) {
      console.error('Failed to sync workspace context:', err);
    }

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

    return conv;
  });

  ipcMain.handle('save-conversation', async (_event, conv: ConversationFile) => {
    const wsId = conv.workspaceId;
    if (wsId) {
      const dir = getWorkspaceConversationsDir(wsId);
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, `${conv.id}.json`);

      try {
        const raw = await fs.readFile(filePath, 'utf-8');
        const existingConv: ConversationFile = JSON.parse(raw) as ConversationFile;
        conv.themeId = existingConv.themeId ?? FIRST_THEME_ID;
      } catch {
        if (!conv.themeId) conv.themeId = FIRST_THEME_ID;
      }

      await fs.writeFile(filePath, JSON.stringify(conv, null, 2), 'utf-8');
    } else {
      await fs.mkdir(getGeneralConversationsDir(), { recursive: true });
      const filePath = path.join(getGeneralConversationsDir(), `${conv.id}.json`);

      try {
        const raw = await fs.readFile(filePath, 'utf-8');
        const existingConv: ConversationFile = JSON.parse(raw) as ConversationFile;
        conv.themeId = existingConv.themeId ?? FIRST_THEME_ID;
      } catch {
        if (!conv.themeId) conv.themeId = FIRST_THEME_ID;
      }

      await fs.writeFile(filePath, JSON.stringify(conv, null, 2), 'utf-8');
    }
  });

  ipcMain.handle('delete-conversation', async (_event, id: string, workspaceId?: string | null) => {
    if (workspaceId) {
      const wsPath = path.join(getWorkspaceConversationsDir(workspaceId), `${id}.json`);
      await fs.unlink(wsPath).catch(() => {});
    }
    const legacyPath = path.join(getGeneralConversationsDir(), `${id}.json`);
    await fs.unlink(legacyPath).catch(() => {});
  });

  ipcMain.handle('rename-conversation', async (_event, id: string, title: string, workspaceId?: string | null) => {
    console.log('[Main] rename-conversation called:', { id, title, workspaceId });
    let filePath: string | null = null;
    if (workspaceId) {
      const wsPath = path.join(getWorkspaceConversationsDir(workspaceId), `${id}.json`);
      console.log('[Main] Checking workspace path:', wsPath);
      try {
        await fs.access(wsPath);
        filePath = wsPath;
        console.log('[Main] Found in workspace dir');
      } catch {
        console.log('[Main] Not in workspace dir');
      }
    }
    if (!filePath) {
      const generalPath = path.join(getGeneralConversationsDir(), `${id}.json`);
      console.log('[Main] Checking general path:', generalPath);
      try {
        await fs.access(generalPath);
        filePath = generalPath;
        console.log('[Main] Found in general dir');
      } catch {
        console.log('[Main] Not in general dir either');
      }
    }

    if (filePath) {
      console.log('[Main] Renaming file:', filePath);
      const raw = await fs.readFile(filePath, 'utf-8');
      const conv: ConversationFile = JSON.parse(raw) as ConversationFile;
      conv.title = title;
      await fs.writeFile(filePath, JSON.stringify(conv, null, 2), 'utf-8');
      console.log('[Main] Rename successful');
    } else {
      console.log('[Main] ERROR: File not found for rename');
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
    };

    if (workspaceId) {
      const dir = getWorkspaceConversationsDir(workspaceId);
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, `${id}.json`);
      await fs.writeFile(filePath, JSON.stringify(conv, null, 2), 'utf-8');
    } else {
      await fs.mkdir(getGeneralConversationsDir(), { recursive: true });
      const filePath = path.join(getGeneralConversationsDir(), `${id}.json`);
      await fs.writeFile(filePath, JSON.stringify(conv, null, 2), 'utf-8');
    }

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
    const filePath = path.join(getGeneralConversationsDir(), `${id}.json`);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const conv: ConversationFile = JSON.parse(raw) as ConversationFile;
      conv.themeId = themeId;
      conv.updatedAt = new Date().toISOString();
      await fs.writeFile(filePath, JSON.stringify(conv, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to update conversation theme:', err);
    }
  });

  ipcMain.handle('get-active-conversation-id', async () => mainState.activeConversationId);
}
