import { spawn } from 'child_process';
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

/**
 * Spawns `python server.py` from the repo’s `python/` folder; logs stdout/stderr in dev.
 * Skips spawn when another healthy instance is already listening (common after electronmon restarts).
 */
export async function ensurePythonServer(): Promise<void> {
  if (await isPythonHealthy()) {
    console.log(`[Python] Reusing existing server on ${PYTHON_URL}`);
    return;
  }
  startPythonServer();
  await waitForPython();
}

/**
 * Spawns `python server.py` from the repo’s `python/` folder; logs stdout/stderr in dev.
 */
export function startPythonServer(): void {
  if (mainState.pythonProcess) {
    return;
  }
  const pythonCmd = getPythonExecutable();
  const scriptPath = getPythonServerScriptPath();
  const logDir = getLogsDir();
  const stagingDir = getWorkspaceStagingDir();
  const checkpointDb = getCheckpointDbPath();
  const workspaceSemanticIndexDir = getWorkspaceSemanticIndexDir();
  const javaLspCacheDir = getJavaLspCacheDir();
  mkdirSync(logDir, { recursive: true });
  mkdirSync(stagingDir, { recursive: true });
  mkdirSync(workspaceSemanticIndexDir, { recursive: true });
  mkdirSync(javaLspCacheDir, { recursive: true });
  mkdirSync(path.dirname(checkpointDb), { recursive: true });

  mainState.pythonProcess = spawn(pythonCmd, ['-u', scriptPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      NEMO_LOG_DIR: logDir,
      NEMO_STAGING_DIR: stagingDir,
      NEMO_CHECKPOINT_DB: checkpointDb,
      NEMO_WORKSPACE_INDEX_DIR: workspaceSemanticIndexDir,
      NEMO_JAVA_LSP_CACHE_DIR: javaLspCacheDir,
    },
  });

  mainState.pythonProcess.stdout?.on('data', (data: Buffer) => {
    console.log(`[Python] ${data.toString().trim()}`);
  });

  mainState.pythonProcess.stderr?.on('data', (data: Buffer) => {
    const text = data.toString().trim();
    console.log(`[Python] ${text}`);
    void ingestElectronLog('INFO', 'nemo.electron.python.stderr', text, 'electron');
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
}

/** Poll `/health` until the FastAPI (or similar) stack is accepting requests. */
export async function waitForPython(
  /** Cold Python imports + FastAPI lifespan can exceed 15s on slower machines. */
  retries = 120,
  intervalMs = 500,
): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await pythonControlFetch('/health');
      if (res.ok) return;
    } catch {
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Python server failed to start');
}
