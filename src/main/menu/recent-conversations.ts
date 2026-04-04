import path = require('path');
const syncFs = require('fs');
import type { ConversationSummary } from '../../shared';
import { loadConfigSync } from '../config/load-save';
import { getGeneralConversationsDir, getWorkspaceConversationsDir } from '../paths';

function collectConversationSummaries(dir: string, target: ConversationSummary[]): void {
  try {
    const files = syncFs.readdirSync(dir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = syncFs.readFileSync(path.join(dir, file), 'utf-8');
        const conv = JSON.parse(raw) as { id?: string; title?: string; updatedAt?: string };
        if (typeof conv.id === 'string' && typeof conv.title === 'string' && typeof conv.updatedAt === 'string') {
          target.push({ id: conv.id, title: conv.title, updatedAt: conv.updatedAt });
        }
      } catch {
        // skip malformed files
      }
    }
  } catch {
    // directory may not exist yet
  }
}

/** Used by the File → Open Recent submenu (global + per-workspace JSON dirs). */
export function getRecentConversations(limit: number): { id: string; title: string }[] {
  try {
    const metas: ConversationSummary[] = [];
    const config = loadConfigSync();
    collectConversationSummaries(getGeneralConversationsDir(), metas);

    for (const workspace of config.workspaces) {
      collectConversationSummaries(getWorkspaceConversationsDir(workspace.id), metas);
    }

    metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return metas.slice(0, limit);
  } catch {
    return [];
  }
}
