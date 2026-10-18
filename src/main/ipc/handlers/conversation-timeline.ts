import { ipcMain } from 'electron';

import type {
  AppendConversationFileJournalRequest,
  ConversationFile,
  ResetTurnFilesRequest,
  ResetTurnFilesResult,
  RestoreConversationTimelineRequest,
  RestoreConversationTimelineResult,
  TurnEditedFileRow,
  TurnFileDiffResult,
} from '../../../shared';
import {
  fallbackJournalFromMessages,
  invertJournalEntries,
  isConversationFileJournalOp,
  journalUserIdsToInvert,
  parseFileJournalSsePayload,
  resolveRestoreUserIndex,
  truncateMessagesAfterUserTurn,
} from '../../../shared';
import { loadConfigSync } from '../../config/load-save';
import { applyTimelineInvertActions } from '../../conversation-timeline';
import {
  appendConversationFileJournal,
  deleteConversationFileJournalForUserIds,
  getConversationById,
  listConversationFileJournal,
  upsertConversation,
} from '../../conversations-db';
import { ensurePythonReady } from '../../python/server';
import { pythonControlFetch } from '../../python/http-client';
import { getTurnFileDiff, listTurnFiles, resetTurnFiles } from '../../turn-edits';
import { assertTrustedMainRenderer } from '../assert-trusted-renderer';

function pythonHistoryMessages(messages: ConversationFile['messages']): unknown[] {
  const pyMessages: unknown[] = [];
  for (const m of messages) {
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
  return pyMessages;
}

async function resyncPythonHistory(conversationId: string, messages: ConversationFile['messages']): Promise<void> {
  try {
    await ensurePythonReady();
    await pythonControlFetch('/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: conversationId, messages: pythonHistoryMessages(messages) }),
    });
  } catch (err) {
    console.error('[ConversationTimeline] Failed to sync history with Python:', err);
  }
}

/** Absolute root of a configured workspace id, or null. */
export function workspacePathForWorkspaceId(workspaceId: string | null | undefined): string | null {
  const wid = workspaceId?.trim();
  if (!wid) {
    return null;
  }
  const ws = loadConfigSync().workspaces.find((w) => w.id === wid);
  return ws?.path?.trim() || null;
}

function workspacePathForConversation(conv: ConversationFile): string | null {
  return workspacePathForWorkspaceId(conv.workspaceId);
}

function workspacePathForConversationId(conversationId: string): string | null {
  const conv = getConversationById(conversationId);
  return conv ? workspacePathForConversation(conv) : null;
}

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function registerConversationTimelineIpc(): void {
  ipcMain.handle('list-conversation-file-journal', async (event, conversationId: string) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      return [];
    }
    if (typeof conversationId !== 'string' || !conversationId.trim()) {
      return [];
    }
    return listConversationFileJournal(conversationId.trim());
  });

  ipcMain.handle(
    'append-conversation-file-journal',
    async (event, raw: AppendConversationFileJournalRequest | unknown) => {
      try {
        assertTrustedMainRenderer(event);
      } catch {
        return { ok: false as const, error: 'Forbidden' };
      }
      const parsed = parseFileJournalSsePayload(raw);
      const conversationId =
        raw && typeof raw === 'object' && typeof (raw as AppendConversationFileJournalRequest).conversationId === 'string'
          ? (raw as AppendConversationFileJournalRequest).conversationId.trim()
          : '';
      if (!parsed || !conversationId) {
        return { ok: false as const, error: 'Invalid journal entry.' };
      }
      if (!isConversationFileJournalOp(parsed.op)) {
        return { ok: false as const, error: 'Invalid journal op.' };
      }
      const entry = appendConversationFileJournal({ conversationId, ...parsed });
      return { ok: true as const, entry };
    },
  );

  ipcMain.handle(
    'list-turn-files',
    async (event, conversationId: unknown, userMessageId: unknown): Promise<TurnEditedFileRow[]> => {
      try {
        assertTrustedMainRenderer(event);
      } catch {
        return [];
      }
      const convId = nonEmptyString(conversationId);
      const turnId = nonEmptyString(userMessageId);
      if (!convId || !turnId) {
        return [];
      }
      return listTurnFiles(convId, turnId, workspacePathForConversationId(convId));
    },
  );

  ipcMain.handle(
    'get-turn-file-diff',
    async (event, conversationId: unknown, userMessageId: unknown, relativePath: unknown): Promise<TurnFileDiffResult> => {
      try {
        assertTrustedMainRenderer(event);
      } catch {
        return { ok: false, error: 'Forbidden' };
      }
      const convId = nonEmptyString(conversationId);
      const turnId = nonEmptyString(userMessageId);
      const rel = nonEmptyString(relativePath);
      if (!convId || !turnId || !rel) {
        return { ok: false, error: 'Invalid turn file request.' };
      }
      return getTurnFileDiff(convId, turnId, rel);
    },
  );

  ipcMain.handle(
    'reset-turn-files',
    async (event, request: ResetTurnFilesRequest | unknown): Promise<ResetTurnFilesResult> => {
      try {
        assertTrustedMainRenderer(event);
      } catch {
        return { ok: false, error: 'Forbidden' };
      }
      const raw = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
      const convId = nonEmptyString(raw['conversationId']);
      const turnId = nonEmptyString(raw['userMessageId']);
      if (!convId || !turnId) {
        return { ok: false, error: 'Invalid reset request.' };
      }
      const paths = Array.isArray(raw['paths'])
        ? raw['paths'].filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        : undefined;
      return resetTurnFiles(
        { conversationId: convId, userMessageId: turnId, paths, force: raw['force'] === true },
        workspacePathForConversationId(convId),
      );
    },
  );

  ipcMain.handle(
    'restore-conversation-timeline',
    async (event, request: RestoreConversationTimelineRequest): Promise<RestoreConversationTimelineResult> => {
      try {
        assertTrustedMainRenderer(event);
      } catch {
        return { ok: false, error: 'Forbidden' };
      }
      const conversationId = request?.conversationId?.trim();
      if (!conversationId) {
        return { ok: false, error: 'No conversation id.' };
      }
      const conv = getConversationById(conversationId);
      if (!conv) {
        return { ok: false, error: 'Conversation not found.' };
      }
      const keepThrough = resolveRestoreUserIndex(conv.messages, request);
      if (keepThrough < 0) {
        return { ok: false, error: 'Restore point is not a user message.' };
      }

      const invertIds = journalUserIdsToInvert(conv.messages, keepThrough);
      const selected = conv.messages[keepThrough];
      const fallbackId =
        (selected?.role === 'user' && selected.id) || `restore-${keepThrough}`;
      const stored = listConversationFileJournal(conversationId);
      const fromDb = stored.filter((e) => invertIds.has(e.userMessageId));
      const fromCards =
        fromDb.length === 0
          ? fallbackJournalFromMessages(conv.messages, keepThrough, fallbackId)
          : [];
      const actions = invertJournalEntries([...fromDb, ...fromCards], new Set([...invertIds, fallbackId]));

      let revertedPaths: string[] = [];
      let skippedPaths: string[] = [];
      const workspaceRoot = workspacePathForConversation(conv);
      if (actions.length > 0 && !workspaceRoot) {
        return { ok: false, error: 'No workspace root for this conversation; cannot revert files.' };
      }
      if (workspaceRoot && actions.length > 0) {
        const applied = await applyTimelineInvertActions(workspaceRoot, actions);
        revertedPaths = applied.revertedPaths;
        skippedPaths = applied.skippedPaths;
      }
      if (skippedPaths.length > 0) {
        return {
          ok: false,
          error: 'Some files could not be reverted.',
          revertedPaths,
          skippedPaths,
        };
      }

      const nextMessages = truncateMessagesAfterUserTurn(conv.messages, keepThrough);
      conv.messages = nextMessages;
      conv.updatedAt = new Date().toISOString();
      upsertConversation(conv);
      deleteConversationFileJournalForUserIds(conversationId, [...invertIds]);
      await resyncPythonHistory(conversationId, nextMessages);

      return { ok: true, messages: nextMessages, revertedPaths, skippedPaths };
    },
  );
}
