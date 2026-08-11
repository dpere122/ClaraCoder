import { getRecentConversationSummaries } from '../conversations-db';

const DEFAULT_RECENT_LIMIT = 50;
const MAX_RECENT_LIMIT = 200;

/** Clamp IPC/caller limit: non-positive/non-numeric → default; cap at {@link MAX_RECENT_LIMIT}. */
export function clampRecentLimit(limit: number): number {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_RECENT_LIMIT;
  }
  return Math.min(Math.floor(n), MAX_RECENT_LIMIT);
}

/** Recent conversations across workspaces (SQLite). */
export function getRecentConversations(limit: number): { id: string; title: string }[] {
  try {
    const safeLimit = clampRecentLimit(limit);
    return getRecentConversationSummaries(safeLimit).map((s) => ({
      id: s.id,
      title: s.title,
    }));
  } catch {
    return [];
  }
}
