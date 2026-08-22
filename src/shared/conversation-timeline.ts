import type { ConversationMessage } from './types/conversation';
import type { FileDiffPayload } from './types/diff';
import type {
  AppendConversationFileJournalRequest,
  ConversationFileJournalEntry,
  ConversationTimelineInvertAction,
} from './types/conversation-timeline';

export type {
  AppendConversationFileJournalRequest,
  ConversationFileJournalEntry,
  ConversationFileJournalOp,
  ConversationFileJournalTreeEntry,
  ConversationTimelineInvertAction,
  RestoreConversationTimelineRequest,
  RestoreConversationTimelineResult,
} from './types/conversation-timeline';

const JOURNAL_OPS = new Set(['create', 'modify', 'delete', 'delete-tree', 'copy']);

export function isConversationFileJournalOp(value: string): value is ConversationFileJournalEntry['op'] {
  return JOURNAL_OPS.has(value);
}

export function lastUserMessageId(messages: readonly ConversationMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && m.id) {
      return m.id;
    }
  }
  return undefined;
}

/** Index of the user prompt to restore (that row is removed; earlier messages stay), or -1. */
export function resolveRestoreUserIndex(
  messages: readonly ConversationMessage[],
  target: { userMessageId?: string; userMessageIndex?: number },
): number {
  const id = target.userMessageId?.trim();
  if (id) {
    const byId = messages.findIndex((m) => m.role === 'user' && m.id === id);
    if (byId >= 0) {
      return byId;
    }
  }
  const idx = target.userMessageIndex;
  if (typeof idx === 'number' && Number.isInteger(idx) && idx >= 0 && idx < messages.length) {
    return messages[idx]?.role === 'user' ? idx : -1;
  }
  return -1;
}

export function canRestoreToUserMessage(
  messages: readonly ConversationMessage[],
  userIndex: number,
  opts?: { streaming?: boolean },
): boolean {
  if (userIndex < 0 || userIndex >= messages.length || messages[userIndex]?.role !== 'user') {
    return false;
  }
  if (userIndex < messages.length - 1) {
    return true;
  }
  return Boolean(opts?.streaming);
}

/**
 * User-turn ids whose landed mutations must be inverted.
 * Includes the selected user message (that turn's agent writes) and every later user turn.
 */
export function journalUserIdsToInvert(
  messages: readonly ConversationMessage[],
  keepThroughIndex: number,
): Set<string> {
  const ids = new Set<string>();
  const selected = messages[keepThroughIndex];
  if (selected?.role === 'user' && selected.id) {
    ids.add(selected.id);
  }
  for (let i = keepThroughIndex + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user' && m.id) {
      ids.add(m.id);
    }
  }
  return ids;
}

export function truncateMessagesAfterUserTurn(
  messages: readonly ConversationMessage[],
  keepThroughIndex: number,
): ConversationMessage[] {
  if (keepThroughIndex <= 0) {
    return [];
  }
  return messages.slice(0, keepThroughIndex);
}

function affectedPath(entry: ConversationFileJournalEntry): string {
  if (entry.op === 'copy') {
    return (entry.destRelativePath || entry.relativePath).replace(/\\/g, '/');
  }
  return entry.relativePath.replace(/\\/g, '/');
}

/**
 * Invert journal rows for discarded turns: first mutation per path after the restore point.
 */
export function invertJournalEntries(
  entries: readonly ConversationFileJournalEntry[],
  invertUserIds: ReadonlySet<string>,
): ConversationTimelineInvertAction[] {
  const filtered = entries
    .filter((e) => invertUserIds.has(e.userMessageId))
    .slice()
    .sort((a, b) => a.seq - b.seq);

  const firstByPath = new Map<string, ConversationFileJournalEntry>();
  for (const entry of filtered) {
    const path = affectedPath(entry);
    if (!path || firstByPath.has(path)) {
      continue;
    }
    firstByPath.set(path, entry);
  }

  const actions: ConversationTimelineInvertAction[] = [];
  for (const [path, entry] of firstByPath) {
    actions.push(invertOne(path, entry));
  }
  return actions;
}

function invertOne(path: string, entry: ConversationFileJournalEntry): ConversationTimelineInvertAction {
  switch (entry.op) {
    case 'create':
      return { kind: 'delete', relativePath: path };
    case 'modify':
      if (typeof entry.beforeContent !== 'string') {
        return { kind: 'skip', relativePath: path, reason: 'missing before content' };
      }
      return {
        kind: 'write',
        relativePath: path,
        content: entry.beforeContent,
        encoding: entry.beforeEncoding,
        newline: entry.beforeNewline,
      };
    case 'delete':
      if (typeof entry.beforeContent !== 'string') {
        return { kind: 'skip', relativePath: path, reason: 'missing deleted file content' };
      }
      return {
        kind: 'write',
        relativePath: path,
        content: entry.beforeContent,
        encoding: entry.beforeEncoding,
        newline: entry.beforeNewline,
      };
    case 'delete-tree':
      if (!entry.treeEntries?.length) {
        return { kind: 'skip', relativePath: path, reason: 'missing deleted tree snapshot' };
      }
      return { kind: 'write-tree', entries: entry.treeEntries };
    case 'copy': {
      const destExisted = typeof entry.beforeContent === 'string';
      if (destExisted) {
        return {
          kind: 'write',
          relativePath: path,
          content: entry.beforeContent as string,
          encoding: entry.beforeEncoding,
          newline: entry.beforeNewline,
        };
      }
      return { kind: 'delete', relativePath: path };
    }
    default:
      return { kind: 'skip', relativePath: path, reason: `unknown op` };
  }
}

function journalFromDiffPayload(
  payload: FileDiffPayload,
  userMessageId: string,
  seq: number,
): ConversationFileJournalEntry | null {
  const relativePath = payload.relativePath?.trim();
  if (!relativePath) {
    return null;
  }
  const before = payload.fullOriginalContent;
  const created = typeof before !== 'string';
  return {
    userMessageId,
    seq,
    relativePath,
    op: created ? 'create' : 'modify',
    beforeContent: created ? null : before,
    beforeEncoding: payload.diskEncoding,
    beforeNewline: payload.diskNewline === 'crlf' ? 'crlf' : 'lf',
  };
}

/**
 * Best-effort journal from completed HITL cards after `keepThroughIndex` (older conversations).
 */
export function fallbackJournalFromMessages(
  messages: readonly ConversationMessage[],
  keepThroughIndex: number,
  fallbackUserMessageId: string,
): ConversationFileJournalEntry[] {
  const out: ConversationFileJournalEntry[] = [];
  let seq = 0;
  for (let i = keepThroughIndex + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'diff' && (m.reviewStatus ?? 'pending') === 'complete') {
      const row = journalFromDiffPayload(m.payload, fallbackUserMessageId, seq++);
      if (row) {
        out.push(row);
      }
      continue;
    }
    if (m.role === 'staged_transfer_batch' && (m.reviewStatus ?? 'pending') === 'complete') {
      for (const file of m.payload.files ?? []) {
        const resolution = m.fileResolutions?.[file.relativePath];
        if (resolution && resolution !== 'approved') {
          continue;
        }
        const row = journalFromDiffPayload(file, fallbackUserMessageId, seq++);
        if (row) {
          out.push(row);
        }
      }
    }
  }
  return out;
}

export function parseFileJournalSsePayload(raw: unknown): Omit<AppendConversationFileJournalRequest, 'conversationId'> | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const o = raw as Record<string, unknown>;
  const userMessageId = typeof o['userMessageId'] === 'string' ? o['userMessageId'].trim() : '';
  const relativePath = typeof o['relativePath'] === 'string' ? o['relativePath'].trim() : '';
  const op = typeof o['op'] === 'string' ? o['op'] : '';
  if (!userMessageId || !relativePath || !isConversationFileJournalOp(op)) {
    return null;
  }
  const destRaw = o['destRelativePath'];
  const dest = typeof destRaw === 'string' && destRaw.trim() ? destRaw.trim() : undefined;
  const treeRaw = o['treeEntries'];
  const treeEntries = Array.isArray(treeRaw)
    ? treeRaw
        .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === 'object')
        .map((e) => {
          const newline = e['newline'];
          return {
            relativePath: typeof e['relativePath'] === 'string' ? e['relativePath'] : '',
            content: typeof e['content'] === 'string' ? e['content'] : '',
            encoding: typeof e['encoding'] === 'string' ? e['encoding'] : undefined,
            newline: newline === 'crlf' ? ('crlf' as const) : newline === 'lf' ? ('lf' as const) : undefined,
          };
        })
        .filter((e) => e.relativePath && typeof e.content === 'string')
    : undefined;
  const beforeContent = o['beforeContent'];
  const beforeEncoding = o['beforeEncoding'];
  const beforeNewline = o['beforeNewline'];
  return {
    userMessageId,
    op,
    relativePath,
    beforeContent: typeof beforeContent === 'string' ? beforeContent : beforeContent === null ? null : undefined,
    beforeEncoding: typeof beforeEncoding === 'string' ? beforeEncoding : undefined,
    beforeNewline: beforeNewline === 'crlf' ? 'crlf' : beforeNewline === 'lf' ? 'lf' : undefined,
    destRelativePath: dest,
    treeEntries,
  };
}

export function journalPreviewPaths(actions: readonly ConversationTimelineInvertAction[]): string[] {
  const paths: string[] = [];
  for (const a of actions) {
    if (a.kind === 'write' || a.kind === 'delete' || a.kind === 'skip') {
      paths.push(a.relativePath);
    } else if (a.kind === 'write-tree') {
      for (const e of a.entries) {
        paths.push(e.relativePath);
      }
    }
  }
  return [...new Set(paths)];
}
