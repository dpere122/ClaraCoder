/**
 * End-of-turn edit review: snapshot what each user turn wrote, list / diff it, and reset paths
 * back to their pre-turn state. Edits land on disk during the turn; the `file_journal` rows
 * (first write per path per turn) hold the "before" side and disk at `[DONE]` is the "after".
 */
import { promises as fs } from 'fs';

import type {
  ConversationFileJournalEntry,
  ResetTurnFilesRequest,
  ResetTurnFilesResult,
  TurnEditedFile,
  TurnEditedFileRow,
  TurnFileDiffResult,
} from '../shared';
import { firstJournalEntryPerPath, invertJournalEntries, journalAffectedPath, textLineChangeCounts } from '../shared';
import { applyTimelineInvertActions } from './conversation-timeline';
import {
  listConversationFileJournalForTurn,
  listConversationTurnFiles,
  setConversationTurnFilesStatus,
  upsertConversationTurnFiles,
  type ConversationTurnFileRecord,
} from './conversations-db';
import { decodeWorkspaceFileContent } from './utils/workspace-file-encoding';
import { resolveSafeWorkspacePath } from './utils/workspace-safe-path';

/** Larger files are tracked as existing but without text (no diff / exact conflict check). */
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

interface DiskSnapshot {
  exists: boolean;
  /** Decoded LF text; null for directories, binary or oversized files. */
  content: string | null;
}

async function readDiskSnapshot(workspaceRoot: string, relativePath: string, encoding?: string): Promise<DiskSnapshot> {
  let abs: string;
  try {
    abs = resolveSafeWorkspacePath(workspaceRoot, relativePath);
  } catch {
    return { exists: false, content: null };
  }
  try {
    const st = await fs.stat(abs);
    if (!st.isFile() || st.size > MAX_SNAPSHOT_BYTES) {
      return { exists: true, content: null };
    }
    const buf = await fs.readFile(abs);
    const enc = encoding?.trim() || 'utf-8';
    if (buf.includes(0) && !enc.startsWith('utf-16')) {
      return { exists: true, content: null };
    }
    return { exists: true, content: decodeWorkspaceFileContent(buf, enc) };
  } catch (e) {
    const code = e && typeof e === 'object' && 'code' in e ? (e as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { exists: false, content: null };
    }
    return { exists: true, content: null };
  }
}

function countLines(text: string): number {
  return textLineChangeCounts('', text).additions;
}

function beforeSide(entry: ConversationFileJournalEntry): { existed: boolean; content: string | null } {
  switch (entry.op) {
    case 'create':
      return { existed: false, content: null };
    case 'copy':
      return typeof entry.beforeContent === 'string'
        ? { existed: true, content: entry.beforeContent }
        : { existed: false, content: null };
    case 'delete-tree':
      return { existed: true, content: null };
    default:
      return { existed: true, content: typeof entry.beforeContent === 'string' ? entry.beforeContent : null };
  }
}

export function turnEditedFileFromRecord(r: ConversationTurnFileRecord): TurnEditedFile {
  return {
    relativePath: r.relativePath,
    op: r.op,
    additions: r.additions,
    deletions: r.deletions,
    status: r.status,
  };
}

/** True when disk still holds exactly what the turn left at `relativePath`. */
async function diskMatchesTurnAfter(workspaceRoot: string, record: ConversationTurnFileRecord): Promise<boolean> {
  const disk = await readDiskSnapshot(workspaceRoot, record.relativePath, record.encoding);
  if (!record.afterExists) {
    return !disk.exists;
  }
  if (!disk.exists) {
    return false;
  }
  if (record.afterContent === null || disk.content === null) {
    // Untracked text (binary / oversized / directory): existence is all we can compare.
    return record.afterContent === null && disk.content === null;
  }
  return disk.content === record.afterContent;
}

/**
 * Snapshot one finished turn: first journal row per path is the "before", current disk the
 * "after". Persists `conversation_turn_files` rows and returns the footer summary. Paths whose
 * net change is empty (written then restored within the turn) are dropped.
 */
export async function finalizeTurnEdits(
  conversationId: string,
  userMessageId: string,
  workspaceRoot: string,
): Promise<TurnEditedFile[]> {
  const convId = conversationId.trim();
  const turnId = userMessageId.trim();
  const root = workspaceRoot.trim();
  if (!convId || !turnId || !root) {
    return [];
  }
  const firsts = firstJournalEntryPerPath(listConversationFileJournalForTurn(convId, turnId), turnId);
  if (firsts.length === 0) {
    return [];
  }
  const existing = new Map(listConversationTurnFiles(convId, turnId).map((r) => [r.relativePath, r]));
  const records: ConversationTurnFileRecord[] = [];
  for (const entry of firsts) {
    const relativePath = journalAffectedPath(entry);
    const before = beforeSide(entry);
    const encoding = entry.beforeEncoding;
    const after = await readDiskSnapshot(root, relativePath, encoding);
    let counts: { additions: number; deletions: number };
    if (entry.op === 'delete-tree') {
      const deletions = (entry.treeEntries ?? []).reduce((n, e) => n + countLines(e.content), 0);
      counts = { additions: 0, deletions: after.exists ? 0 : deletions };
    } else {
      if (before.existed === after.exists && before.content !== null && before.content === after.content) {
        continue;
      }
      if (!before.existed && !after.exists) {
        continue;
      }
      counts = textLineChangeCounts(before.content ?? '', after.content ?? '');
    }
    records.push({
      conversationId: convId,
      userMessageId: turnId,
      relativePath,
      op: entry.op,
      beforeContent: before.content,
      beforeExisted: before.existed,
      afterContent: after.content,
      afterExists: after.exists,
      encoding,
      newline: entry.beforeNewline,
      additions: counts.additions,
      deletions: counts.deletions,
      status: existing.get(relativePath)?.status ?? 'kept',
    });
  }
  upsertConversationTurnFiles(records);
  return records.map(turnEditedFileFromRecord);
}

/** Turn-file rows with a live "changed since this turn" disk check for kept paths. */
export async function listTurnFiles(
  conversationId: string,
  userMessageId: string,
  workspaceRoot: string | null,
): Promise<TurnEditedFileRow[]> {
  const records = listConversationTurnFiles(conversationId.trim(), userMessageId.trim());
  const rows: TurnEditedFileRow[] = [];
  for (const r of records) {
    const changedSinceTurn =
      r.status === 'kept' && !!workspaceRoot?.trim() ? !(await diskMatchesTurnAfter(workspaceRoot.trim(), r)) : false;
    rows.push({ ...turnEditedFileFromRecord(r), changedSinceTurn });
  }
  return rows;
}

export function getTurnFileDiff(conversationId: string, userMessageId: string, relativePath: string): TurnFileDiffResult {
  const norm = relativePath.replace(/\\/g, '/').trim();
  const record = listConversationTurnFiles(conversationId.trim(), userMessageId.trim()).find(
    (r) => r.relativePath === norm,
  );
  if (!record) {
    return { ok: false, error: 'No edit recorded for this file in that turn.' };
  }
  return {
    ok: true,
    relativePath: record.relativePath,
    op: record.op,
    before: record.beforeContent ?? '',
    after: record.afterContent ?? '',
    beforeExisted: record.beforeExisted,
    afterExists: record.afterExists,
  };
}

/**
 * Revert turn paths to their pre-turn state. Without `force`, paths whose disk content changed
 * since the turn come back as `conflicts` and nothing is written.
 */
export async function resetTurnFiles(
  request: ResetTurnFilesRequest,
  workspaceRoot: string | null,
): Promise<ResetTurnFilesResult> {
  const conversationId = request.conversationId?.trim() ?? '';
  const userMessageId = request.userMessageId?.trim() ?? '';
  if (!conversationId || !userMessageId) {
    return { ok: false, error: 'Missing conversation or turn id.' };
  }
  const root = workspaceRoot?.trim();
  if (!root) {
    return { ok: false, error: 'No workspace root for this conversation; cannot reset files.' };
  }
  const records = listConversationTurnFiles(conversationId, userMessageId);
  const wanted = request.paths?.length
    ? new Set(request.paths.map((p) => p.replace(/\\/g, '/').trim()))
    : null;
  const targets = records.filter((r) => r.status === 'kept' && (!wanted || wanted.has(r.relativePath)));
  if (targets.length === 0) {
    return { ok: true, resetPaths: [], skippedPaths: [], files: records.map(turnEditedFileFromRecord) };
  }

  if (!request.force) {
    const conflicts: string[] = [];
    for (const r of targets) {
      if (!(await diskMatchesTurnAfter(root, r))) {
        conflicts.push(r.relativePath);
      }
    }
    if (conflicts.length > 0) {
      return { ok: false, conflicts, error: 'Some files changed since this turn.' };
    }
  }

  const journal = listConversationFileJournalForTurn(conversationId, userMessageId);
  const turnIds = new Set([userMessageId]);
  const resetPaths: string[] = [];
  const skippedPaths: string[] = [];
  for (const r of targets) {
    const entries = journal.filter((e) => journalAffectedPath(e) === r.relativePath);
    const actions = invertJournalEntries(entries, turnIds);
    if (actions.length === 0) {
      skippedPaths.push(r.relativePath);
      continue;
    }
    const applied = await applyTimelineInvertActions(root, actions);
    if (applied.skippedPaths.length > 0) {
      skippedPaths.push(r.relativePath);
    } else {
      resetPaths.push(r.relativePath);
    }
  }
  setConversationTurnFilesStatus(conversationId, userMessageId, resetPaths, 'reset');
  const files = listConversationTurnFiles(conversationId, userMessageId).map(turnEditedFileFromRecord);
  return { ok: true, resetPaths, skippedPaths, files };
}
