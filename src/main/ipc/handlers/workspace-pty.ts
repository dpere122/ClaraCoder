import { existsSync } from 'fs';
import { ipcMain } from 'electron';
import * as pty from 'node-pty';
import { mainState } from '../../state';

const sessions = new Map<string, pty.IPty>();

function envForPtyChild(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (!env.PYTHONIOENCODING?.trim()) env.PYTHONIOENCODING = 'utf-8';
  if (!env.PYTHONUTF8?.trim()) env.PYTHONUTF8 = '1';
  return env;
}

function defaultShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: 'powershell.exe', args: ['-NoLogo'] };
  }
  const shell = process.env.SHELL?.trim() || '/bin/bash';
  return { file: shell, args: [] };
}

function sendData(sessionId: string, data: string): void {
  mainState.mainWindow?.webContents.send('workspace-pty-data', { sessionId, data });
}

function sendExit(sessionId: string, exitCode: number, signal: number | null): void {
  mainState.mainWindow?.webContents.send('workspace-pty-exit', { sessionId, exitCode, signal });
}

/** Kill every workspace PTY (app quit or workspace switch). */
export function killAllWorkspacePtySessions(): void {
  for (const [, term] of sessions) {
    try {
      term.kill();
    } catch {
      /* ignore */
    }
  }
  sessions.clear();
}

/** Registers IPC for the workspace terminal dock (node-pty in main). */
export function registerWorkspacePtyIpc(): void {
  ipcMain.handle(
    'workspace-pty-spawn',
    async (_event, cwd: string, cols: unknown, rows: unknown) => {
      const c = typeof cwd === 'string' ? cwd.trim() : '';
      if (!c || !existsSync(c)) {
        return { success: false as const, error: 'Invalid or missing workspace directory' };
      }
      const colN = typeof cols === 'number' && Number.isFinite(cols) ? cols : 80;
      const rowN = typeof rows === 'number' && Number.isFinite(rows) ? rows : 24;
      const sessionId = `pty-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
      const { file, args } = defaultShell();
      try {
        const baseOpts: pty.IPtyForkOptions = {
          name: 'xterm-256color',
          cols: Math.max(2, Math.floor(colN)),
          rows: Math.max(1, Math.floor(rowN)),
          cwd: c,
          env: envForPtyChild(),
        };
        // `useConptyDll: true` avoids forking `conpty_console_list_agent` on kill, which calls
        // `AttachConsole(innerPid)` and can throw "AttachConsole failed" when tearing down the
        // last session (e.g. closing the final terminal tab) under Electron on Windows.
        const term =
          process.platform === 'win32'
            ? pty.spawn(file, args, { ...baseOpts, useConpty: true, useConptyDll: true })
            : pty.spawn(file, args, baseOpts);
        sessions.set(sessionId, term);
        term.onData((data) => {
          sendData(sessionId, data);
        });
        term.onExit(({ exitCode, signal }) => {
          sessions.delete(sessionId);
          sendExit(sessionId, exitCode, signal ?? null);
        });
        return { success: true as const, sessionId };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false as const, error: message };
      }
    },
  );

  ipcMain.handle('workspace-pty-write', async (_event, sessionId: unknown, data: unknown) => {
    const id = typeof sessionId === 'string' ? sessionId : '';
    const chunk = typeof data === 'string' ? data : '';
    const term = sessions.get(id);
    if (!term) {
      return { success: false as const, error: 'Session not found' };
    }
    try {
      term.write(chunk);
      return { success: true as const };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false as const, error: message };
    }
  });

  ipcMain.handle('workspace-pty-resize', async (_event, sessionId: unknown, cols: unknown, rows: unknown) => {
    const id = typeof sessionId === 'string' ? sessionId : '';
    const term = sessions.get(id);
    if (!term) {
      return { success: false as const, error: 'Session not found' };
    }
    const colN = typeof cols === 'number' && Number.isFinite(cols) ? Math.max(2, Math.floor(cols)) : 80;
    const rowN = typeof rows === 'number' && Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : 24;
    try {
      term.resize(colN, rowN);
      return { success: true as const };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false as const, error: message };
    }
  });

  ipcMain.handle('workspace-pty-kill', async (_event, sessionId: unknown) => {
    const id = typeof sessionId === 'string' ? sessionId : '';
    const term = sessions.get(id);
    if (!term) {
      return { success: false as const, error: 'Session not found' };
    }
    try {
      term.kill();
      sessions.delete(id);
      return { success: true as const };
    } catch (err: unknown) {
      sessions.delete(id);
      const message = err instanceof Error ? err.message : String(err);
      return { success: false as const, error: message };
    }
  });

  ipcMain.handle('workspace-pty-kill-all', async () => {
    killAllWorkspacePtySessions();
    return { success: true as const };
  });
}
