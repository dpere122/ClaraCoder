import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { ipcMain } from 'electron';
import * as path from 'path';
import * as pty from 'node-pty';
import { assertTrustedMainRenderer } from '../assert-trusted-renderer';
import { mainState } from '../../state';
import { envForChildProcess } from '../../utils/filter-sensitive-env';
import { validateWorkspacePtyCwd } from '../../utils/workspace-pty-cwd';

const sessions = new Map<string, pty.IPty>();

function envForPtyChild(): NodeJS.ProcessEnv {
  return envForChildProcess();
}

/**
 * Candidate shells to try, in order. The first that exists on disk wins. Returning a list lets
 * us fall back to ``cmd.exe`` if PowerShell is missing (which is common on Windows Server / Nano).
 */
function candidateShells(): Array<{ file: string; args: string[] }> {
  if (process.platform === 'win32') {
    const windir = (process.env.SystemRoot || process.env.windir || 'C:\\Windows').trim();
    return [
      {
        file: path.join(windir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        args: ['-NoLogo'],
      },
      { file: path.join(windir, 'System32', 'cmd.exe'), args: [] },
      { file: 'powershell.exe', args: ['-NoLogo'] },
      { file: 'cmd.exe', args: [] },
    ];
  }
  const shell = process.env.SHELL?.trim();
  const candidates: Array<{ file: string; args: string[] }> = [
    { file: '/bin/zsh', args: [] },
    { file: '/bin/bash', args: [] },
    { file: '/bin/sh', args: [] },
  ];
  if (shell && path.isAbsolute(shell)) {
    candidates.push({ file: shell, args: [] });
  }
  candidates.push({ file: shell || '/bin/bash', args: [] });
  return candidates;
}

function pickShell(): { file: string; args: string[] } {
  const candidates = candidateShells();
  for (const c of candidates) {
    if (path.isAbsolute(c.file)) {
      if (existsSync(c.file)) {
        return c;
      }
    } else {
      // Bare command: trust PATH at spawn time.
      return c;
    }
  }
  return candidates[candidates.length - 1];
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
    async (event, workspaceRoot: unknown, cwd: unknown, cols: unknown, rows: unknown) => {
      try {
        assertTrustedMainRenderer(event);
      } catch {
        return { success: false as const, error: 'Forbidden' };
      }
      const wr = typeof workspaceRoot === 'string' ? workspaceRoot : '';
      const cw = typeof cwd === 'string' ? cwd : '';
      const validated = await validateWorkspacePtyCwd(wr, cw);
      if (!validated.ok) {
        return { success: false as const, error: validated.error };
      }
      const cwdReal = validated.cwdReal;
      const colN = typeof cols === 'number' && Number.isFinite(cols) ? cols : 80;
      const rowN = typeof rows === 'number' && Number.isFinite(rows) ? rows : 24;
      const sessionId = `pty-${randomUUID()}`;
      const { file, args } = pickShell();
      console.log('[workspace-pty] spawn', { sessionId, workspaceRoot: wr.trim(), cwd: cwdReal, file, args });
      try {
        const baseOpts: pty.IPtyForkOptions = {
          name: 'xterm-256color',
          cols: Math.max(2, Math.floor(colN)),
          rows: Math.max(1, Math.floor(rowN)),
          cwd: cwdReal,
          env: envForPtyChild(),
        };
        // ConPTY builds use a fork (`conpty_console_list_agent`) on `kill()` to enumerate child PIDs via
        // `AttachConsole`. During app shutdown that often throws **AttachConsole failed** and crashes the
        // helper as an uncaught exception (electronmon picks it up). WinPTY skips that path; trade-off is a
        // slightly older PTY backend, which is acceptable for integrated shells until node-pty ships a fix.
        // `useConptyDll: true` would still require bundled `conpty.dll` (absent here → spawn errors).
        const term =
          process.platform === 'win32'
            ? pty.spawn(file, args, { ...baseOpts, useConpty: false })
            : pty.spawn(file, args, baseOpts);
        sessions.set(sessionId, term);
        term.onData((data) => {
          sendData(sessionId, data);
        });
        term.onExit(({ exitCode, signal }) => {
          sessions.delete(sessionId);
          sendExit(sessionId, exitCode, signal ?? null);
        });
        console.log('[workspace-pty] spawn ok', { sessionId, pid: term.pid });
        return { success: true as const, sessionId };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[workspace-pty] spawn failed', { sessionId, file, error: message });
        return { success: false as const, error: `${message} (shell: ${file})` };
      }
    },
  );

  ipcMain.handle('workspace-pty-write', async (event, sessionId: unknown, data: unknown) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      return { success: false as const, error: 'Forbidden' };
    }
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

  ipcMain.handle('workspace-pty-resize', async (event, sessionId: unknown, cols: unknown, rows: unknown) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      return { success: false as const, error: 'Forbidden' };
    }
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

  ipcMain.handle('workspace-pty-kill', async (event, sessionId: unknown) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      return { success: false as const, error: 'Forbidden' };
    }
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

  ipcMain.handle('workspace-pty-kill-all', async (event) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      return { success: false as const, error: 'Forbidden' };
    }
    killAllWorkspacePtySessions();
    return { success: true as const };
  });
}
