import { createHash } from 'crypto';
import { existsSync, mkdirSync, renameSync, cpSync, rmSync, readdirSync, readFileSync } from 'fs';
import { app } from 'electron';
import path = require('path');
import { migrateLegacyAppDataDir } from './app-data';
import { envClara } from './env-clara';
import { WORKSPACE_META_DIR, WORKSPACE_SYSTEM_PROMPT_FILE } from '../shared';

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

/** Single managed workspace system-prompt copy under app data (legacy; migrated into `.clara`). */
export function getLegacyAppDataSystemPromptPath(workspaceId: string): string {
  return path.join(getWorkspaceDir(workspaceId), 'system-prompt.md');
}

/** Workspace-tree system prompt: `{workspaceRoot}/.clara/system-prompt.md`. */
export function getWorkspaceSystemPromptPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, WORKSPACE_META_DIR, WORKSPACE_SYSTEM_PROMPT_FILE);
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

/** Sanitize a workspace id for the semantic-index bucket folder (matches Python). */
export function workspaceSemanticIndexBucketId(workspaceId: string): string {
  const wid = workspaceId.trim();
  const safe = (wid.replace(/[^a-zA-Z0-9._-]/g, '_') || 'workspace').slice(0, 200);
  return safe;
}

/** Persist dir for one workspace corpus: ``workspace-semantic-index/workspaces/{id}``. */
export function getWorkspaceSemanticIndexPersistDir(workspaceId: string): string {
  return path.join(
    getWorkspaceSemanticIndexDir(),
    'workspaces',
    workspaceSemanticIndexBucketId(workspaceId),
  );
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

export const BUNDLED_RUNTIME_MANIFEST_FILE = '.clara-runtime-manifest.json';

export interface BundledRuntimeManifest {
  schemaVersion: number;
  pythonVersion: string;
  pbsRelease?: string;
  requirementsSource?: string;
  requirementsSha256?: string;
  builtAt?: string;
  platform?: string;
  arch?: string;
}

/** Env keys stripped from packaged sidecar / deps-CLI spawns (inherited interpreter leakage). */
export const PYTHON_ENV_KEYS_TO_STRIP = [
  'PYTHONPATH',
  'PYTHONHOME',
  'PYTHONSTARTUP',
  'PYTHONUSERBASE',
  'PYTHONSAFEPATH',
] as const;

/** Root of the portable CPython tree (packaged extraResources vs repo runtime-bundle). */
export function getBundledRuntimeDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'runtime-python')
    : path.join(__dirname, '..', '..', 'runtime-bundle', 'python');
}

/** Portable CPython shipped with the packaged app (`extraResources/runtime-python`). */
export function getBundledPythonExecutable(): string | null {
  const base = getBundledRuntimeDir();
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

/** Parse ``<bundle root>/.clara-runtime-manifest.json``. Null when missing or invalid; never throws. */
export function readBundledRuntimeManifest(): BundledRuntimeManifest | null {
  const file = path.join(getBundledRuntimeDir(), BUNDLED_RUNTIME_MANIFEST_FILE);
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.schemaVersion !== 'number' || typeof rec.pythonVersion !== 'string') {
      return null;
    }
    return parsed as BundledRuntimeManifest;
  } catch {
    return null;
  }
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
 * Bundled ripgrep binary for the sidecar's workspace search.
 *
 * Packaged: ``extraResources/ripgrep`` (fetched by ``npm run bundle:rg``).
 * Dev: ``runtime-bundle/ripgrep/`` at the repo root.
 * Returns ``null`` when the bundle is absent, so the sidecar falls back to rg/grep on PATH.
 */
export function getBundledRipgrep(): string | null {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'ripgrep')
    : path.join(__dirname, '..', '..', 'runtime-bundle', 'ripgrep');
  const binary = path.join(base, process.platform === 'win32' ? 'rg.exe' : 'rg');
  return existsSync(binary) ? binary : null;
}

/** ``key = …`` from ``<root>/pyvenv.cfg``, or null when absent. */
function readPyvenvValue(root: string, key: string): string | null {
  let text: string;
  try {
    text = readFileSync(path.join(root, 'pyvenv.cfg'), 'utf8');
  } catch {
    return null;
  }
  for (const raw of text.split(/\r?\n/)) {
    const eq = raw.indexOf('=');
    if (eq < 0) continue;
    if (raw.slice(0, eq).trim().toLowerCase() !== key) continue;
    const value = raw.slice(eq + 1).trim();
    return value || null;
  }
  return null;
}

/** ``home = …`` from ``<root>/pyvenv.cfg`` (base interpreter directory), or null when absent. */
export function readPyvenvHome(root: string): string | null {
  return readPyvenvValue(root, 'home');
}

/** Requirements SHA the Python provider writes to ``.clara-requirements-hash`` ('' when unknown). */
export function expectedRequirementsHash(): string {
  if (getBundledPythonExecutable()) {
    const manifest = readBundledRuntimeManifest();
    if (manifest) return manifest.requirementsSha256 ?? '';
  }
  try {
    const req = path.join(path.dirname(getPythonServerScriptPath()), 'requirements.txt');
    return createHash('sha256').update(readFileSync(req)).digest('hex');
  } catch {
    return '';
  }
}

/**
 * Why an isolated runtime venv (its own core packages, no bundled overlay) is out of date with
 * ``requirements.txt``, or null. Nothing lists the venv any more, so a sidecar started from it
 * would fail on a missing package with no way to repair it; Kokoro / Whisper installs update it.
 */
export function isolatedVenvStaleReason(root: string): string | null {
  if (readPyvenvValue(root, 'include-system-site-packages')?.toLowerCase() !== 'false') return null;
  const expected = expectedRequirementsHash();
  if (!expected) return null;
  let stored = '';
  try {
    stored = readFileSync(path.join(root, '.clara-requirements-hash'), 'utf8').trim();
  } catch {
    /* no marker: treat as stale */
  }
  return stored === expected ? null : 'packages out of date with requirements.txt';
}

function stripTrailingSeps(p: string): string {
  return p.replace(/[\\/]+$/, '');
}

function normalizeInterpreterHome(p: string): string {
  const resolved = stripTrailingSeps(path.resolve(p));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** True when ``pyvenv.cfg`` ``home`` is the directory that contains ``bundledExe``. */
export function venvBelongsToBundledRuntime(venvRoot: string, bundledExe: string): boolean {
  const home = readPyvenvHome(venvRoot);
  if (!home) return false;
  return normalizeInterpreterHome(home) === normalizeInterpreterHome(path.dirname(bundledExe));
}

/** True when the base interpreter recorded by ``home`` still exists. */
function venvBaseInterpreterExists(home: string): boolean {
  if (!existsSync(home)) return false;
  const names = process.platform === 'win32' ? ['python.exe'] : ['python3', 'python'];
  return names.some((name) => existsSync(path.join(home, name)));
}

/**
 * Why a venv at ``root`` cannot be launched, or null when it looks fine.
 *
 * - Windows venv launchers (`Scripts/python.exe`) refuse to start without ``pyvenv.cfg``
 *   (exit 106: "No pyvenv.cfg file"). An interrupted ``python -m venv`` can leave the
 *   exe behind with no cfg.
 * - The launcher also needs the base interpreter from ``home = …`` (exit 103:
 *   "No Python at '…'"). That happens when the venv was created from the bundled
 *   portable Python of an app install that was since removed or moved.
 *
 * Callers treat either case as "no venv" so we fall back to bundled / repo / system Python
 * and the dependency installer can recreate it.
 */
export function pythonVenvUnusableReason(root: string): string | null {
  const cfg = path.join(root, 'pyvenv.cfg');
  if (!existsSync(cfg)) return 'missing pyvenv.cfg';
  const home = readPyvenvHome(root);
  if (home && !venvBaseInterpreterExists(home)) {
    return `base interpreter missing at ${home}`;
  }
  return null;
}

export function isUsablePythonVenv(root: string): boolean {
  return pythonVenvUnusableReason(root) === null;
}

/**
 * Interpreter-resolution warnings queued for the sidecar spawner to ingest into the
 * unified log (this module cannot import ``log-ingest`` without a cycle).
 */
const pythonResolutionNotes: string[] = [];

function notePythonResolution(message: string): void {
  console.warn(`[Python] ${message}`);
  if (!pythonResolutionNotes.includes(message)) pythonResolutionNotes.push(message);
}

/** Drain queued resolution warnings (caller logs them via ``ingestElectronLog``). */
export function consumePythonResolutionNotes(): string[] {
  return pythonResolutionNotes.splice(0, pythonResolutionNotes.length);
}

function runtimeVenvPython(opts: { packaged: boolean; bundledExe: string | null }): string | null {
  const root = getRuntimePythonDir();
  const unix = path.join(root, 'bin', 'python');
  const win = path.join(root, 'Scripts', 'python.exe');
  const exe = existsSync(unix) ? unix : existsSync(win) ? win : null;
  if (!exe) return null;
  const reason = pythonVenvUnusableReason(root);
  if (reason) {
    notePythonResolution(`Ignoring unusable runtime venv at ${root} (${reason})`);
    return null;
  }
  const stale = isolatedVenvStaleReason(root);
  if (stale) {
    notePythonResolution(`Ignoring runtime venv at ${root} (${stale})`);
    return null;
  }
  if (opts.packaged) {
    if (!opts.bundledExe || !venvBelongsToBundledRuntime(root, opts.bundledExe)) {
      const home = readPyvenvHome(root);
      notePythonResolution(
        `Ignoring runtime venv at ${root}: not created from the bundled runtime (home=${home})`,
      );
      return null;
    }
  }
  return exe;
}

let loggedMissingBundledRuntime = false;

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
 *
 * Packaged: the app-data runtime venv when it was created from this install's bundled
 * interpreter (``pyvenv.cfg`` ``home`` equals the bundled exe directory); otherwise the
 * bundled portable Python. No ``CLARA_PYTHON``, PATH, or repo ``.venv`` fallback —
 * missing bundle returns ``null``.
 *
 * Dev (``!app.isPackaged``): ``CLARA_PYTHON`` → runtime app-data venv (if usable) →
 * bundled portable Python → repo ``.venv`` → system ``python`` / ``python3``.
 */
export function getPythonExecutable(): string | null {
  if (app.isPackaged) {
    const bundled = getBundledPythonExecutable();
    if (!bundled) {
      if (!loggedMissingBundledRuntime) {
        loggedMissingBundledRuntime = true;
        console.error(`[Python] Bundled Python runtime missing at ${getBundledRuntimeDir()}`);
      }
      return null;
    }
    const venv = runtimeVenvPython({ packaged: true, bundledExe: bundled });
    return venv ?? bundled;
  }

  const fromEnv = envClara('PYTHON');
  if (fromEnv) return fromEnv;

  const runtimePy = runtimeVenvPython({ packaged: false, bundledExe: getBundledPythonExecutable() });
  if (runtimePy) return runtimePy;

  const bundled = getBundledPythonExecutable();
  if (bundled) return bundled;

  const scriptPath = getPythonServerScriptPath();
  const repoRoot = path.dirname(path.dirname(scriptPath));
  const unix = path.join(repoRoot, '.venv', 'bin', 'python');
  const win = path.join(repoRoot, '.venv', 'Scripts', 'python.exe');
  if (existsSync(unix)) return unix;
  if (existsSync(win)) return win;

  return process.platform === 'win32' ? 'python' : 'python3';
}

/**
 * Isolation + discovery env for sidecar / deps-CLI spawns (packaged only).
 *
 * ``CLARA_BUNDLED_PYTHON`` switches the Python deps providers into "bundled mode"
 * (thin overlay venv, ownership check on the app-data venv). Dev deliberately sets
 * nothing so the Python side mirrors Electron's dev chain (repo ``.venv`` / system).
 */
export function pythonIsolationEnv(): NodeJS.ProcessEnv {
  if (!app.isPackaged) return {};
  return {
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
    CLARA_BUNDLED_PYTHON: getBundledPythonExecutable() ?? '',
    CLARA_BUNDLED_RUNTIME_DIR: getBundledRuntimeDir(),
  };
}

/** Absolute path to managed llama-server when installed under runtime/bin. */
export function getManagedLlamaServerPath(): string | null {
  const name = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const p = path.join(getRuntimeBinDir(), name);
  return existsSync(p) ? p : null;
}
