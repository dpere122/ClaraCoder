import { getRecentConversationSummaries } from '../conversations-db';

/** Recent conversations across workspaces (SQLite). */
export function getRecentConversations(limit: number): { id: string; title: string }[] {
  try {
    return getRecentConversationSummaries(limit).map((s) => ({
      id: s.id,
      title: s.title,
    }));
  } catch {
    return [];
  }
}
