import { ipcMain } from 'electron';
import { assertTrustedMainRenderer } from '../assert-trusted-renderer';
import { mainState } from '../../state';
import { pythonControlFetch } from '../../python/http-client';

/** Poll Python diagnostics generation and push updates to the renderer (Phase 6 live push). */

let watchTimer: ReturnType<typeof setInterval> | null = null;
let watchSessionId = '';
let watchRelativePath = '';
let lastGeneration = -1;
let lastEpoch = -1;

async function pollDiagnosticsGeneration(): Promise<void> {
  if (!watchSessionId || !watchRelativePath) {
    return;
  }
  try {
    const params = new URLSearchParams({
      session_id: watchSessionId,
      relative_path: watchRelativePath,
    });
    const res = await pythonControlFetch(`/lsp/diagnostics-generation?${params.toString()}`);
    if (!res.ok) {
      return;
    }
    const data = (await res.json()) as { generation?: number; epoch?: number };
    const gen = data.generation ?? 0;
    const epoch = data.epoch ?? 0;
    if (gen !== lastGeneration || epoch !== lastEpoch) {
      lastGeneration = gen;
      lastEpoch = epoch;
      mainState.mainWindow?.webContents.send('lsp-diagnostics-updated', {
        sessionId: watchSessionId,
        relativePath: watchRelativePath,
        generation: gen,
        epoch,
      });
    }
  } catch {
    // ignore transient poll failures
  }
}

export function registerLspDiagnosticsWatchIpc(): void {
  ipcMain.on('lsp-diagnostics-watch-start', (event, sessionId: unknown, relativePath: unknown) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      return;
    }
    const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
    const rel = typeof relativePath === 'string' ? relativePath.trim().replace(/\\/g, '/') : '';
    // Idempotent for the active target: refresh paths call watch-start repeatedly, and
    // resetting lastGeneration to -1 would re-emit lsp-diagnostics-updated → refresh loop.
    if (sid && rel && sid === watchSessionId && rel === watchRelativePath && watchTimer !== null) {
      return;
    }
    watchSessionId = sid;
    watchRelativePath = rel;
    lastGeneration = -1;
    lastEpoch = -1;
    if (watchTimer !== null) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
    if (!sid || !rel) {
      return;
    }
    void pollDiagnosticsGeneration();
    watchTimer = setInterval(() => void pollDiagnosticsGeneration(), 900);
  });

  ipcMain.on('lsp-diagnostics-watch-stop', (event) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      return;
    }
    watchSessionId = '';
    watchRelativePath = '';
    lastGeneration = -1;
    lastEpoch = -1;
    if (watchTimer !== null) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
  });
}
