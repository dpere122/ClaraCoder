import { createHash, randomBytes } from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync } from 'fs';
import path = require('path');
import { mainState } from '../state';
import { PYTHON_PORT, PYTHON_URL } from '../constants';
import { getPythonSidecarToken, pythonControlFetch, setPythonSidecarToken } from './http-client';
import {
  getCheckpointDbPath,
  getJavaLspCacheDir,
  getLogsDir,
  getPythonExecutable,
  getPythonServerScriptPath,
  getRuntimeBinDir,
  getRuntimeDir,
  getRuntimePythonDir,
  getWorkspaceSemanticIndexDir,
  getWorkspaceStagingDir,
  getBundledVtslsEntry,
} from '../paths';
import { ingestElectronLog } from '../log-ingest';
import { getDefaultCustomModelsDir } from '../config/defaults';
import { loadConfigSync } from '../config/load-save';
import { unwrapSecret } from '../../shared';
import { killProcessTree } from '../utils/kill-process-tree';

export { PYTHON_URL, PYTHON_PORT };

/** Process-lifetime sidecar shared secret (hex). Generated once; passed to the child at spawn. */
function ensureSidecarToken(): string {
  let token = getPythonSidecarToken();
  if (!token) {
    token = randomBytes(32).toString('hex');
    setPythonSidecarToken(token);
  }
  return token;
}

/** First 16 hex chars of sha256(token) — must match Python `/health` `x_clara_sidecar`. */
export function expectedSidecarMarker(token = getPythonSidecarToken()): string {
  if (!token) return '';
  return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16);
}

async function fetchHealthPayload(): Promise<
  { reachable: false } | { reachable: true; ok: boolean; marker: string }
> {
  try {
    // /health is auth-exempt on our sidecar; bearer is harmless if present.
    const res = await pythonControlFetch('/health');
    let marker = '';
    if (res.ok) {
      try {
        const body = (await res.json()) as { x_clara_sidecar?: unknown };
        marker = typeof body.x_clara_sidecar === 'string' ? body.x_clara_sidecar : '';
      } catch {
        marker = '';
      }
    }
    return { reachable: true, ok: res.ok, marker };
  } catch {
    return { reachable: false };
  }
}

/**
 * True when the listener on `PYTHON_PORT` is our sidecar (health ok + marker matches our token).
 * Returns false for a dead port, wrong marker, or a foreign process.
 */
export async function isPythonHealthy(): Promise<boolean> {
  ensureSidecarToken();
  const expected = expectedSidecarMarker();
  const health = await fetchHealthPayload();
  if (!health.reachable || !health.ok) return false;
  return health.marker === expected && expected.length > 0;
}

/**
 * Probe the port: distinguish "nothing listening", "our sidecar", and "foreign listener".
 */
async function probePythonListener(): Promise<'down' | 'ours' | 'foreign'> {
  ensureSidecarToken();
  const expected = expectedSidecarMarker();
  const health = await fetchHealthPayload();
  if (!health.reachable) return 'down';
  if (health.ok && health.marker === expected && expected.length > 0) return 'ours';
  return 'foreign';
}

/** Shared wait so concurrent startup IPC (workspace sync, history load, …) polls once. */
let pythonReadyWait: Promise<void> | null = null;

/**
 * Block until `/health` succeeds. Used by early UI→Python syncs that race the sidecar boot
 * (main window opens before `ensurePythonServer` finishes).
 */
export async function ensurePythonReady(
  retries = 120,
  intervalMs = 500,
): Promise<void> {
  if (await isPythonHealthy()) {
    return;
  }
  const probe = await probePythonListener();
  if (probe === 'foreign') {
    throw new Error(
      `Foreign process already listening on PYTHON_PORT (${PYTHON_PORT}); refusing to treat it as the Clara sidecar.`,
    );
  }
  if (!pythonReadyWait) {
    pythonReadyWait = waitForPython(mainState.pythonProcess, retries, intervalMs).finally(() => {
      pythonReadyWait = null;
    });
  }
  await pythonReadyWait;
}

/**
 * Spawns `python server.py` from the repo’s `python/` folder; logs stdout/stderr in dev.
 * Skips spawn when our healthy instance is already listening. Rejects a foreign listener.
 */
export async function ensurePythonServer(): Promise<void> {
  const probe = await probePythonListener();
  if (probe === 'ours') {
    console.log(`[Python] Reusing existing server on ${PYTHON_URL}`);
    return;
  }
  if (probe === 'foreign') {
    throw new Error(
      `Foreign process already listening on PYTHON_PORT (${PYTHON_PORT}); refusing to reuse it as the Clara sidecar.`,
    );
  }
  const proc = startPythonServer();
  await waitForPython(proc);
}

/**
 * After a sidecar restart the new process boots with in-memory defaults.
 * Re-push Settings so STT/LLM config (and managed llama URLs) survive dependency installs that reload the venv.
 */
async function resyncRuntimeConfigAfterSidecarRestart(): Promise<void> {
  try {
    const { loadConfigSync } = await import('../config/load-save');
    const { syncRuntimeConfigToPython } = await import('./workspace-sync');
    const { getLlamaManagedRuntimeOverrides } = await import('../llama-server-manager');
    const config = loadConfigSync();
    await syncRuntimeConfigToPython(config, () => getLlamaManagedRuntimeOverrides(config));
  } catch (err) {
    const msg = `Runtime config re-sync after restart failed: ${err instanceof Error ? err.message : err}`;
    console.error(`[Python] ${msg}`);
    void ingestElectronLog('WARNING', 'clara.electron.python', msg, 'electron');
  }
}

/**
 * Kill the managed sidecar (if any) and start a fresh process using the current
 * ``getPythonExecutable()`` (so post-install runtime venv / Kokoro is picked up).
 */
export async function restartPythonServer(): Promise<void> {
  if (mainState.pythonProcess) {
    console.log('[Python] Restarting sidecar to pick up runtime changes…');
    stopPythonSidecar();
    // Brief pause so the port is released before re-bind.
    await new Promise((r) => setTimeout(r, 400));
  } else {
    mainState.pythonProcess = null;
  }
  // If another orphan still holds the port, wait for it to die (do not reuse foreign).
  for (let i = 0; i < 20; i++) {
    const probe = await probePythonListener();
    if (probe === 'down') break;
    if (probe === 'foreign') {
      throw new Error(
        `Foreign process still listening on PYTHON_PORT (${PYTHON_PORT}) after restart; cannot spawn sidecar.`,
      );
    }
    // 'ours' with a dying child — keep waiting for the port to free.
    await new Promise((r) => setTimeout(r, 200));
  }
  const next = startPythonServer();
  await waitForPython(next);
  await resyncRuntimeConfigAfterSidecarRestart();
}

/**
 * Spawns `python server.py` from the repo’s `python/` folder; logs stdout/stderr in dev.
 * Returns the child process (existing or newly spawned) so callers can detect early exit.
 */
export function startPythonServer(): ChildProcess {
  if (mainState.pythonProcess) {
    return mainState.pythonProcess;
  }
  const sidecarToken = ensureSidecarToken();
  const pythonCmd = getPythonExecutable();
  const scriptPath = getPythonServerScriptPath();
  const logDir = getLogsDir();
  const stagingDir = getWorkspaceStagingDir();
  const checkpointDb = getCheckpointDbPath();
  const workspaceSemanticIndexDir = getWorkspaceSemanticIndexDir();
  const javaLspCacheDir = getJavaLspCacheDir();
  const runtimeDir = getRuntimeDir();
  mkdirSync(logDir, { recursive: true });
  mkdirSync(stagingDir, { recursive: true });
  mkdirSync(workspaceSemanticIndexDir, { recursive: true });
  mkdirSync(javaLspCacheDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(getRuntimeBinDir(), { recursive: true });
  // Do not mkdir python-venv here — an empty dir can confuse install/status; deps install creates it.
  mkdirSync(path.dirname(checkpointDb), { recursive: true });

  let hfToken = '';
  try {
    hfToken = unwrapSecret(loadConfigSync().modelManager.huggingFaceToken).trim();
  } catch {
    hfToken = '';
  }
  console.log(`[Python] Spawning sidecar: ${pythonCmd}`);
  const child = spawn(pythonCmd, ['-u', scriptPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    /** POSIX: new session so ``kill(-pid)`` tears down LSP / run_command children. */
    detached: process.platform !== 'win32',
    windowsHide: true,
    env: {
      // numpy's bundled OpenBLAS pre-commits a per-thread buffer pool sized to the core
      // count at import (~490 MB committed on a 16-core box). The sidecar never does
      // numpy-level BLAS work, so cap it at 1. Deliberately NOT setting OMP_NUM_THREADS:
      // Kokoro (torch) and faster-whisper (CTranslate2) run in-process on CPU and use it
      // for their own intra-op parallelism. Spread first so a user override still wins.
      OPENBLAS_NUM_THREADS: '1',
      ...process.env,
      PYTHONUNBUFFERED: '1',
      CLARA_SIDECAR_TOKEN: sidecarToken,
      CLARA_PYTHON_PORT: String(PYTHON_PORT),
      CLARA_LOG_DIR: logDir,
      CLARA_STAGING_DIR: stagingDir,
      CLARA_CHECKPOINT_DB: checkpointDb,
      CLARA_WORKSPACE_INDEX_DIR: workspaceSemanticIndexDir,
      CLARA_JAVA_LSP_CACHE_DIR: javaLspCacheDir,
      CLARA_RUNTIME_DIR: runtimeDir,
      CLARA_RUNTIME_PYTHON_DIR: getRuntimePythonDir(),
      CLARA_RUNTIME_BIN_DIR: getRuntimeBinDir(),
      CLARA_CUSTOM_MODELS_DIR: process.env.CLARA_CUSTOM_MODELS_DIR || getDefaultCustomModelsDir(),
      // Lets the Python sidecar run the bundled vtsls LSP via the Electron binary in
      // Node mode (ELECTRON_RUN_AS_NODE=1) without requiring a system Node install.
      CLARA_ELECTRON_EXEC_PATH: process.execPath,
      CLARA_VTSLS_BUNDLED_ENTRY: getBundledVtslsEntry() ?? '',
      ...(hfToken ? { HF_TOKEN: hfToken, HUGGING_FACE_HUB_TOKEN: hfToken } : {}),
    },
  });
  mainState.pythonProcess = child;

  child.stdout?.on('data', (data: Buffer) => {
    console.log(`[Python] ${data.toString().trim()}`);
  });

  child.stderr?.on('data', (data: Buffer) => {
    const text = data.toString().trim();
    console.log(`[Python] ${text}`);
    void ingestElectronLog('INFO', 'clara.electron.python.stderr', text, 'electron');
  });

  child.on('error', (err: Error) => {
    const msg = `Python sidecar error pid=${child.pid ?? '?'} ${err.message}`;
    console.error(`[Python] ${msg}`);
    void ingestElectronLog('ERROR', 'clara.electron.python', msg, 'electron');
  });

  child.on('close', (code, signal) => {
    const level = code === 0 ? 'INFO' : 'ERROR';
    const msg = `Python sidecar exited pid=${child.pid ?? '?'} code=${code} signal=${signal ?? ''}`;
    console.log(`[Python] ${msg}`);
    void ingestElectronLog(level, 'clara.electron.python', msg, 'electron');
    if (mainState.pythonProcess === child) {
      mainState.pythonProcess = null;
    }
    if (code !== 0) {
      void isPythonHealthy().then((healthy) => {
        if (healthy) {
          console.log(`[Python] Port ${PYTHON_PORT} still served by another process — continuing`);
        }
      });
    }
  });

  return child;
}

/**
 * Stop the Python sidecar and every descendant (LSP, background ``run_command``,
 * FastEmbed/ONNX workers). ``ChildProcess.kill()`` alone leaves those on Windows
 * and POSIX, which is why RAM stays high after closing Clara Coder.
 */
export function stopPythonSidecar(): void {
  const proc = mainState.pythonProcess;
  if (!proc) {
    return;
  }
  killProcessTree(proc);
  if (mainState.pythonProcess === proc) {
    mainState.pythonProcess = null;
  }
}

/** Poll `/health` until the FastAPI (or similar) stack is accepting requests. */
export async function waitForPython(
  proc: ChildProcess | null = mainState.pythonProcess,
  /** Cold Python imports + FastAPI lifespan can exceed 15s on slower machines. */
  retries = 120,
  intervalMs = 500,
): Promise<void> {
  // Hold the ChildProcess reference — close handler clears mainState.pythonProcess.
  let exitedCode: number | null = proc?.exitCode ?? null;
  const onClose = (code: number | null): void => {
    exitedCode = code ?? 1;
  };
  proc?.once('close', onClose);

  try {
    for (let i = 0; i < retries; i++) {
      if (exitedCode !== null) {
        throw new Error(`Python server exited early with code ${exitedCode}`);
      }
      try {
        if (await isPythonHealthy()) return;
      } catch {
        // server not up yet
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error('Python server failed to start');
  } finally {
    proc?.off('close', onClose);
  }
}
