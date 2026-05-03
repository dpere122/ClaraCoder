import { getRecentConversationSummaries } from '../conversations-db';

/** Used by the File → Open Recent submenu (SQLite, all workspaces). */
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
