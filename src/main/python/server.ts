import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync } from 'fs';
import path = require('path');
import { mainState } from '../state';
import { PYTHON_PORT, PYTHON_URL } from '../constants';
import { pythonControlFetch } from './http-client';
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
} from '../paths';
import { ingestElectronLog } from '../log-ingest';

export { PYTHON_URL, PYTHON_PORT };

/** True when the sidecar on `PYTHON_PORT` already accepts `/health`. */
export async function isPythonHealthy(): Promise<boolean> {
  try {
    const res = await pythonControlFetch('/health');
    return res.ok;
  } catch {
    return false;
  }
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
  if (!pythonReadyWait) {
    pythonReadyWait = waitForPython(mainState.pythonProcess, retries, intervalMs).finally(() => {
      pythonReadyWait = null;
    });
  }
  await pythonReadyWait;
}

/**
 * Spawns `python server.py` from the repo’s `python/` folder; logs stdout/stderr in dev.
 * Skips spawn when another healthy instance is already listening (common after electronmon restarts).
 */
export async function ensurePythonServer(): Promise<void> {
  if (await isPythonHealthy()) {
    console.log(`[Python] Reusing existing server on ${PYTHON_URL}`);
    return;
  }
  const proc = startPythonServer();
  await waitForPython(proc);
}

/**
 * Kill the managed sidecar (if any) and start a fresh process using the current
 * ``getPythonExecutable()`` (so post-install runtime venv / Kokoro is picked up).
 */
export async function restartPythonServer(): Promise<void> {
  const proc = mainState.pythonProcess;
  if (proc && !proc.killed) {
    console.log('[Python] Restarting sidecar to pick up runtime changes…');
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    mainState.pythonProcess = null;
    // Brief pause so the port is released before re-bind.
    await new Promise((r) => setTimeout(r, 400));
  } else {
    mainState.pythonProcess = null;
  }
  // If another orphan still holds the port, wait for it to die or reuse after kill attempt.
  for (let i = 0; i < 20; i++) {
    if (!(await isPythonHealthy())) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const next = startPythonServer();
  await waitForPython(next);
}

/**
 * Spawns `python server.py` from the repo’s `python/` folder; logs stdout/stderr in dev.
 * Returns the child process (existing or newly spawned) so callers can detect early exit.
 */
export function startPythonServer(): ChildProcess {
  if (mainState.pythonProcess) {
    return mainState.pythonProcess;
  }
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

  console.log(`[Python] Spawning sidecar: ${pythonCmd}`);
  mainState.pythonProcess = spawn(pythonCmd, ['-u', scriptPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      CLARA_LOG_DIR: logDir,
      CLARA_STAGING_DIR: stagingDir,
      CLARA_CHECKPOINT_DB: checkpointDb,
      CLARA_WORKSPACE_INDEX_DIR: workspaceSemanticIndexDir,
      CLARA_JAVA_LSP_CACHE_DIR: javaLspCacheDir,
      CLARA_RUNTIME_DIR: runtimeDir,
      CLARA_RUNTIME_PYTHON_DIR: getRuntimePythonDir(),
      CLARA_RUNTIME_BIN_DIR: getRuntimeBinDir(),
    },
  });

  mainState.pythonProcess.stdout?.on('data', (data: Buffer) => {
    console.log(`[Python] ${data.toString().trim()}`);
  });

  mainState.pythonProcess.stderr?.on('data', (data: Buffer) => {
    const text = data.toString().trim();
    console.log(`[Python] ${text}`);
    void ingestElectronLog('INFO', 'clara.electron.python.stderr', text, 'electron');
  });

  mainState.pythonProcess.on('close', (code) => {
    console.log(`[Python] Process exited with code ${code}`);
    mainState.pythonProcess = null;
    if (code !== 0) {
      void isPythonHealthy().then((healthy) => {
        if (healthy) {
          console.log(`[Python] Port ${PYTHON_PORT} still served by another process — continuing`);
        }
      });
    }
  });

  return mainState.pythonProcess;
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
        const res = await pythonControlFetch('/health');
        if (res.ok) return;
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
