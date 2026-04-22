import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
import path = require('path');
import { mainState } from '../state';
import { PYTHON_PORT, PYTHON_URL } from '../constants';
import { getCheckpointDbPath, getLogsDir, getWorkspaceSemanticIndexDir, getWorkspaceStagingDir } from '../paths';
import { ingestElectronLog } from '../log-ingest';

export { PYTHON_URL, PYTHON_PORT };

/**
 * Spawns `python server.py` from the repo’s `python/` folder; logs stdout/stderr in dev.
 */
export function startPythonServer(): void {
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  // Compiled to dist/main/python/*.js — repo root is three levels up.
  const scriptPath = path.join(__dirname, '..', '..', '..', 'python', 'server.py');
  const logDir = getLogsDir();
  const stagingDir = getWorkspaceStagingDir();
  const checkpointDb = getCheckpointDbPath();
  const workspaceSemanticIndexDir = getWorkspaceSemanticIndexDir();
  mkdirSync(logDir, { recursive: true });
  mkdirSync(stagingDir, { recursive: true });
  mkdirSync(workspaceSemanticIndexDir, { recursive: true });
  mkdirSync(path.dirname(checkpointDb), { recursive: true });

  mainState.pythonProcess = spawn(pythonCmd, [scriptPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NEMO_LOG_DIR: logDir,
      NEMO_STAGING_DIR: stagingDir,
      NEMO_CHECKPOINT_DB: checkpointDb,
      NEMO_WORKSPACE_INDEX_DIR: workspaceSemanticIndexDir,
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
  });
}

/** Poll `/health` until the FastAPI (or similar) stack is accepting requests. */
export async function waitForPython(retries = 30, intervalMs = 500): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${PYTHON_URL}/health`);
      if (res.ok) return;
    } catch {
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Python server failed to start');
}
