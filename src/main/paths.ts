import { app } from 'electron';
import path = require('path');
import { DEV_SERVER_URL } from './constants';

/**
 * Resolves the directory used for config.json, workspaces, and legacy conversations.
 * In dev, forces a stable folder name under appData regardless of the executable name.
 */
export function getAppDataDir(): string {
  if (DEV_SERVER_URL) {
    return path.join(app.getPath('appData'), 'nemo-wrapper');
  }
  return app.getPath('userData');
}

export function getConfigPath(): string {
  return path.join(getAppDataDir(), 'config.json');
}

export function getWorkspacesDir(): string {
  return path.join(getAppDataDir(), 'workspaces');
}

export function getWorkspaceDir(workspaceId: string): string {
  return path.join(getWorkspacesDir(), workspaceId);
}

export function getWorkspaceConversationsDir(workspaceId: string): string {
  return path.join(getWorkspaceDir(workspaceId), 'conversations');
}

export function getGeneralConversationsDir(): string {
  return path.join(getAppDataDir(), 'conversations');
}

/** Rotating app logs (`nemo-app.log*`) — same root as config.json. */
export function getLogsDir(): string {
  return path.join(getAppDataDir(), 'logs');
}

/** Nested edit staging (Python ``NEMO_STAGING_DIR``) — same root as config.json. */
export function getWorkspaceStagingDir(): string {
  return path.join(getAppDataDir(), 'workspace-staging');
}

/** LangGraph Sqlite checkpoints (Python ``NEMO_CHECKPOINT_DB``). */
export function getCheckpointDbPath(): string {
  return path.join(getAppDataDir(), 'langgraph-checkpoints.sqlite');
}

/** Workspace + staging semantic index (Python ``NEMO_WORKSPACE_INDEX_DIR``). */
export function getWorkspaceSemanticIndexDir(): string {
  return path.join(getAppDataDir(), 'workspace-semantic-index');
}
