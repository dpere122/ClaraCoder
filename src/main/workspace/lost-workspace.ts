import { promises as fs } from 'fs';
import type { AppConfig } from '../../shared';
import {
  compactFavoriteOrders,
  isNoWorkspaceSystemPromptId,
  pruneRemovedWorkspaceClientState,
} from '../../shared';
import { loadConfig, updateConfig } from '../config/load-save';
import {
  deleteConversationsByWorkspaceId,
  listConversationIdsByWorkspaceId,
  listDistinctConversationWorkspaceIds,
} from '../conversations-db';
import { abortChatStream } from '../ipc/handlers/chat-stream-state';
import { pythonControlFetch } from '../python/http-client';
import {
  getWorkspaceDir,
  getWorkspaceSemanticIndexPersistDir,
  getWorkspacesDir,
} from '../paths';

/** How a registered workspace root looks on disk. */
export type WorkspaceRootPresence = 'ok' | 'missing' | 'inaccessible';

export interface ReconcileLostWorkspacesResult {
  config: AppConfig;
  /** Workspace ids dropped from the registry because their folder is gone. */
  removedIds: string[];
  currentWorkspaceChanged: boolean;
}

/**
 * Classify a workspace folder. Only ``missing`` is treated as lost.
 * Access / network errors stay registered so a temporarily unavailable drive is not wiped.
 */
export async function classifyWorkspaceRoot(workspacePath: string): Promise<WorkspaceRootPresence> {
  const root = (workspacePath || '').trim();
  if (!root) {
    return 'missing';
  }
  try {
    const st = await fs.stat(root);
    return st.isDirectory() ? 'ok' : 'missing';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return 'missing';
    }
    return 'inaccessible';
  }
}

/** Remove a workspace from the registry and per-workspace client maps. */
export function dropWorkspaceFromConfig(cfg: AppConfig, workspaceId: string): boolean {
  const id = workspaceId.trim();
  if (!id) {
    return false;
  }
  const exists = cfg.workspaces.some((workspace) => workspace.id === id);
  if (exists) {
    cfg.workspaces = compactFavoriteOrders(cfg.workspaces.filter((workspace) => workspace.id !== id));
    if (cfg.currentWorkspaceId === id) {
      cfg.currentWorkspaceId = cfg.workspaces[0]?.id ?? null;
    }
  }
  pruneRemovedWorkspaceClientState(cfg, id);
  return exists;
}

async function disposePythonSessionBestEffort(sessionId: string): Promise<void> {
  try {
    await pythonControlFetch('/dispose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
    });
  } catch (err) {
    console.warn('[workspace] Failed to dispose Python session', sessionId, err);
  }
}

async function rmDirBestEffort(dirPath: string): Promise<void> {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch (err) {
    console.warn('[workspace] Failed to remove app-data folder', dirPath, err);
  }
}

async function listOrphanWorkspaceAppDataIds(knownIds: Set<string>): Promise<string[]> {
  try {
    const entries = await fs.readdir(getWorkspacesDir(), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !knownIds.has(name) && !isNoWorkspaceSystemPromptId(name));
  } catch {
    return [];
  }
}

/**
 * Delete chats, LangGraph sessions, and app-data folders for a workspace id.
 * Does not edit ``config.json`` — call {@link dropWorkspaceFromConfig} for that.
 */
export async function purgeWorkspacePersistedData(workspaceId: string): Promise<string[]> {
  const id = workspaceId.trim();
  if (!id || isNoWorkspaceSystemPromptId(id)) {
    return [];
  }

  let conversationIds: string[] = [];
  try {
    conversationIds = listConversationIdsByWorkspaceId(id);
  } catch (err) {
    console.warn('[workspace] Could not list conversations for purge', id, err);
  }

  for (const conversationId of conversationIds) {
    await abortChatStream(conversationId);
    await disposePythonSessionBestEffort(conversationId);
  }

  try {
    deleteConversationsByWorkspaceId(id);
  } catch (err) {
    console.warn('[workspace] Could not delete conversations for', id, err);
  }

  await rmDirBestEffort(getWorkspaceDir(id));
  await rmDirBestEffort(getWorkspaceSemanticIndexPersistDir(id));
  return conversationIds;
}

/**
 * Drop registry entries whose folders are gone, then delete leftover chats and app-data
 * for those ids and for orphans from earlier incomplete removes.
 */
export async function reconcileLostWorkspaces(): Promise<ReconcileLostWorkspacesResult> {
  const before = await loadConfig();
  const previousCurrent = before.currentWorkspaceId;
  const missing: Array<{ id: string; name: string; path: string }> = [];

  for (const workspace of before.workspaces) {
    const status = await classifyWorkspaceRoot(workspace.path);
    if (status === 'missing') {
      missing.push({ id: workspace.id, name: workspace.name, path: workspace.path });
    }
  }

  const keptIds = new Set(
    before.workspaces.filter((workspace) => !missing.some((row) => row.id === workspace.id)).map((workspace) => workspace.id),
  );

  let orphanConversationWorkspaceIds: string[] = [];
  try {
    orphanConversationWorkspaceIds = listDistinctConversationWorkspaceIds().filter(
      (id) => !keptIds.has(id) && !isNoWorkspaceSystemPromptId(id),
    );
  } catch {
    // Conversations DB not open (tests / early boot).
  }

  const orphanAppDataIds = await listOrphanWorkspaceAppDataIds(keptIds);
  const purgeIds = [...new Set([...missing.map((row) => row.id), ...orphanConversationWorkspaceIds, ...orphanAppDataIds])];

  if (missing.length === 0 && purgeIds.length === 0) {
    return { config: before, removedIds: [], currentWorkspaceChanged: false };
  }

  const config = await updateConfig((cfg) => {
    for (const row of missing) {
      dropWorkspaceFromConfig(cfg, row.id);
    }
    for (const id of purgeIds) {
      pruneRemovedWorkspaceClientState(cfg, id);
    }
  });

  for (const row of missing) {
    console.warn(
      `[workspace] Dropped missing workspace "${row.name}" (${row.id}) — folder gone: ${row.path}`,
    );
  }

  for (const id of purgeIds) {
    await purgeWorkspacePersistedData(id);
    if (!missing.some((row) => row.id === id)) {
      console.warn(`[workspace] Purged leftover data for unregistered workspace ${id}`);
    }
  }

  return {
    config,
    removedIds: missing.map((row) => row.id),
    currentWorkspaceChanged: previousCurrent !== config.currentWorkspaceId,
  };
}
