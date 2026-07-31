import { existsSync } from 'fs';
import { app } from 'electron';
import path = require('path');
import { GEMMA4_CHAT_TEMPLATE_FILENAME } from '../shared/gemma-template';
import { QWEN_INFERENCE_CHAT_TEMPLATE_FILENAME } from '../shared/qwen-template';
import { migrateLegacyAppDataDir } from './app-data';
import { envClara } from './env-clara';

let appDataConfigured = false;

/**
 * Migrate legacy data dirs and pin Electron ``userData`` to ``{appData}/clara-coder``.
 * Must run once before any ``getAppDataDir()`` / config / SQLite open.
 */
export function configureAppDataDir(): string {
  if (!appDataConfigured) {
    const { target, migrated, from, method } = migrateLegacyAppDataDir(app.getPath('appData'));
    app.setPath('userData', target);
    appDataConfigured = true;
    if (migrated && from) {
      console.log(`[app-data] Migrated app data (${method}) from ${from} → ${target}`);
    }
  }
  return app.getPath('userData');
}

/**
 * Resolves the directory used for config.json, workspaces, and conversations.
 * Always ``{appData}/clara-coder`` after {@link configureAppDataDir}.
 */
export function getAppDataDir(): string {
  if (!appDataConfigured) {
    return configureAppDataDir();
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

/** Single managed workspace system-prompt copy under app data (not the project tree). */
export function getWorkspaceSystemPromptPath(workspaceId: string): string {
  return path.join(getWorkspaceDir(workspaceId), 'system-prompt.md');
}

export function getGeneralConversationsDir(): string {
  return path.join(getAppDataDir(), 'conversations');
}

/** Rotating app logs (`clara-app.log*`) — same root as config.json. */
export function getLogsDir(): string {
  return path.join(getAppDataDir(), 'logs');
}

/** Nested edit staging (Python ``CLARA_STAGING_DIR``) — same root as config.json. */
export function getWorkspaceStagingDir(): string {
  return path.join(getAppDataDir(), 'workspace-staging');
}

/** Temp snapshots for Monaco tabs detached from missing workspace files. */
export function getEditorDetachedSnapshotsDir(): string {
  return path.join(getAppDataDir(), 'editor-snapshots');
}

/** LangGraph Sqlite checkpoints (Python ``CLARA_CHECKPOINT_DB``). */
export function getCheckpointDbPath(): string {
  return path.join(getAppDataDir(), 'langgraph-checkpoints.sqlite');
}

/** Electron main-process conversation transcripts (``better-sqlite3``). */
export function getConversationsDbPath(): string {
  return path.join(getAppDataDir(), 'conversations.sqlite');
}

/** Workspace + staging semantic index (Python ``CLARA_WORKSPACE_INDEX_DIR``). */
export function getWorkspaceSemanticIndexDir(): string {
  return path.join(getAppDataDir(), 'workspace-semantic-index');
}

/** Eclipse JDT LS download cache (Python ``CLARA_JAVA_LSP_CACHE_DIR``). */
export function getJavaLspCacheDir(): string {
  return path.join(getAppDataDir(), 'java-lsp');
}

/**
 * FastAPI entry script: dev (next to repo `python/`) vs packaged (`extraResources/python/`).
 */
export function getPythonServerScriptPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'python', 'server.py');
  }
  return path.join(__dirname, '..', '..', 'python', 'server.py');
}

/**
 * Path to the bundled Qwen Jinja chat template for managed ``llama-server`` (``--chat-template-file``).
 * Override with ``CLARA_QWEN_CHAT_TEMPLATE_PATH`` (absolute path recommended).
 */
export function getQwenInferenceChatTemplatePath(): string {
  const fromEnv = envClara('QWEN_CHAT_TEMPLATE_PATH');
  if (fromEnv) {
    return path.isAbsolute(fromEnv) ? fromEnv : path.resolve(fromEnv);
  }
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'LLM_Templates', QWEN_INFERENCE_CHAT_TEMPLATE_FILENAME);
  }
  return path.join(__dirname, '..', '..', 'LLM_Templates', QWEN_INFERENCE_CHAT_TEMPLATE_FILENAME);
}

/**
 * Path to the bundled Gemma 4 Jinja chat template for managed ``llama-server`` (``--chat-template-file``).
 * Override with ``CLARA_GEMMA4_CHAT_TEMPLATE_PATH`` (absolute path recommended).
 */
export function getGemma4ChatTemplatePath(): string {
  const fromEnv = envClara('GEMMA4_CHAT_TEMPLATE_PATH');
  if (fromEnv) {
    return path.isAbsolute(fromEnv) ? fromEnv : path.resolve(fromEnv);
  }
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'LLM_Templates', GEMMA4_CHAT_TEMPLATE_FILENAME);
  }
  return path.join(__dirname, '..', '..', 'LLM_Templates', GEMMA4_CHAT_TEMPLATE_FILENAME);
}

/**
 * Interpreter for `server.py`. In dev, uses repo `.venv` when present so launches match
 * `npm run setup:python`. Optional override: `CLARA_PYTHON` (absolute path to executable).
 */
export function getPythonExecutable(): string {
  const fromEnv = envClara('PYTHON');
  if (fromEnv) return fromEnv;

  if (!app.isPackaged) {
    const scriptPath = getPythonServerScriptPath();
    const repoRoot = path.dirname(path.dirname(scriptPath));
    const unix = path.join(repoRoot, '.venv', 'bin', 'python');
    const win = path.join(repoRoot, '.venv', 'Scripts', 'python.exe');
    if (existsSync(unix)) return unix;
    if (existsSync(win)) return win;
  }

  return process.platform === 'win32' ? 'python' : 'python3';
}
