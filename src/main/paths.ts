import { existsSync, mkdirSync, renameSync, cpSync, rmSync, readdirSync } from 'fs';
import { app } from 'electron';
import path = require('path');
import { migrateLegacyAppDataDir } from './app-data';
import { envClara } from './env-clara';

let appDataConfigured = false;

/**
 * Migrate legacy data dirs and pin Electron ``userData`` to ``{appData}/clara-coder``
 * (packaged) or ``{appData}/clara-coder-dev`` (dev). Must run once before any
 * ``getAppDataDir()`` / config / SQLite open.
 */
export function configureAppDataDir(): string {
  if (!appDataConfigured) {
    const isDev = !app.isPackaged;
    const { target, migrated, from, method } = migrateLegacyAppDataDir(app.getPath('appData'), isDev);
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
 * ``{appData}/clara-coder`` (packaged) or ``{appData}/clara-coder-dev`` (dev) after
 * {@link configureAppDataDir}.
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

/** Root for managed runtime dependencies (Python ``CLARA_RUNTIME_DIR``). */
export function getRuntimeDir(): string {
  return path.join(getAppDataDir(), 'runtime');
}

/** App-managed Python venv under the runtime dir. */
export function getRuntimePythonDir(): string {
  return path.join(getRuntimeDir(), 'python-venv');
}

/** Downloaded binaries (e.g. llama-server) under the runtime dir. */
export function getRuntimeBinDir(): string {
  return path.join(getRuntimeDir(), 'bin');
}

/** True when a JDT LS product ready-marker exists under ``cacheRoot/jdtls/``. */
function javaLspCacheHasReadyProduct(cacheRoot: string): boolean {
  const jdtls = path.join(cacheRoot, 'jdtls');
  if (!existsSync(jdtls)) return false;
  try {
    for (const name of readdirSync(jdtls)) {
      if (existsSync(path.join(jdtls, name, '.nemo-ready'))) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Canonical Eclipse JDT LS cache: ``{appData}/runtime/java-lsp``.
 * One-time migrate from legacy ``{appData}/java-lsp`` when that tree has a ready product.
 */
export function getJavaLspCacheDir(): string {
  const runtimeJava = path.join(getRuntimeDir(), 'java-lsp');
  const legacy = path.join(getAppDataDir(), 'java-lsp');
  if (!javaLspCacheHasReadyProduct(runtimeJava) && javaLspCacheHasReadyProduct(legacy)) {
    try {
      mkdirSync(getRuntimeDir(), { recursive: true });
      if (existsSync(runtimeJava)) {
        rmSync(runtimeJava, { recursive: true, force: true });
      }
      try {
        renameSync(legacy, runtimeJava);
      } catch {
        cpSync(legacy, runtimeJava, { recursive: true });
        rmSync(legacy, { recursive: true, force: true });
      }
      console.log(`[app-data] Migrated Java LSP cache ${legacy} → ${runtimeJava}`);
    } catch (err) {
      console.warn('[app-data] Java LSP cache migrate failed:', err);
      if (javaLspCacheHasReadyProduct(legacy)) return legacy;
    }
  }
  return runtimeJava;
}

/** Portable CPython shipped with the packaged app (`extraResources/runtime-python`). */
export function getBundledPythonExecutable(): string | null {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'runtime-python')
    : path.join(__dirname, '..', '..', 'runtime-bundle', 'python');
  const unix = path.join(base, 'bin', 'python3');
  const win = path.join(base, 'python.exe');
  if (existsSync(unix)) return unix;
  if (existsSync(win)) return win;
  // python-build-standalone layout: install/bin/python3
  const unixInstall = path.join(base, 'install', 'bin', 'python3');
  const winInstall = path.join(base, 'install', 'python.exe');
  if (existsSync(unixInstall)) return unixInstall;
  if (existsSync(winInstall)) return winInstall;
  return null;
}

/**
 * Bundled vtsls (TypeScript/JavaScript LSP) entry script.
 *
 * Packaged: ``extraResources/vtsls`` (assembled by ``npm run bundle:vtsls``).
 * Dev: ``vtsls-bundle/`` at the repo root (run ``npm run bundle:vtsls`` once to populate).
 * Returns ``null`` when the bundle is absent, so the Python sidecar falls back to npx.
 */
export function getBundledVtslsEntry(): string | null {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'vtsls')
    : path.join(__dirname, '..', '..', 'vtsls-bundle');
  const entry = path.join(base, 'node_modules', '@vtsls', 'language-server', 'bin', 'vtsls.js');
  return existsSync(entry) ? entry : null;
}

/**
 * Windows venv launchers (`Scripts/python.exe`) refuse to start without ``pyvenv.cfg``
 * (exit 106: "No pyvenv.cfg file"). An interrupted ``python -m venv`` can leave the
 * exe behind with no cfg — treat that as missing so we fall back to bundled / repo / system Python.
 */
export function isUsablePythonVenv(root: string): boolean {
  return existsSync(path.join(root, 'pyvenv.cfg'));
}

function runtimeVenvPython(): string | null {
  const root = getRuntimePythonDir();
  const unix = path.join(root, 'bin', 'python');
  const win = path.join(root, 'Scripts', 'python.exe');
  const exe = existsSync(unix) ? unix : existsSync(win) ? win : null;
  if (!exe) return null;
  if (!isUsablePythonVenv(root)) {
    console.warn(`[Python] Ignoring incomplete runtime venv at ${root} (missing pyvenv.cfg)`);
    return null;
  }
  return exe;
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
 * Interpreter for `server.py`.
 * Order: ``CLARA_PYTHON`` → runtime app-data venv → bundled portable Python →
 * (dev) repo ``.venv`` → system ``python`` / ``python3``.
 */
export function getPythonExecutable(): string {
  const fromEnv = envClara('PYTHON');
  if (fromEnv) return fromEnv;

  const runtimePy = runtimeVenvPython();
  if (runtimePy) return runtimePy;

  const bundled = getBundledPythonExecutable();
  if (bundled) return bundled;

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

/** Absolute path to managed llama-server when installed under runtime/bin. */
export function getManagedLlamaServerPath(): string | null {
  const name = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const p = path.join(getRuntimeBinDir(), name);
  return existsSync(p) ? p : null;
}
