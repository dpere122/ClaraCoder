import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { ipcMain } from 'electron';
import * as path from 'path';
import * as pty from 'node-pty';
import { assertTrustedMainRenderer } from '../assert-trusted-renderer';
import { pythonLogIngestFetch } from '../../python/http-client';
import { mainState } from '../../state';
import { envForChildProcess } from '../../utils/filter-sensitive-env';
import { readPtyProcessCwd } from '../../utils/pty-process-cwd';
import { isSameWorkspaceRootPath } from '../../utils/workspace-entry-transfer';
import { validateWorkspacePtyCwd } from '../../utils/workspace-pty-cwd';
import { notifyWorkspaceTreeRefresh } from '../../workspace/emit-files-changed';

const sessions = new Map<string, pty.IPty>();
/** PTY session id → workspace root (for debounced file-tree refresh after shell output). */
const sessionWorkspaceRoots = new Map<string, string>();
/** Last known filesystem cwd per session (tab titles follow the base folder). */
const sessionLastCwd = new Map<string, string>();
/** Shell binary and dimensions per session (for sidecar re-sync after restart). */
const sessionMeta = new Map<string, { shell: string; cols: number; rows: number }>();
/** Incomplete OSC 7 prefix per PTY session (sequences can split across chunks). */
const osc7RemainderBySession = new Map<string, string>();
const ptyTreeRefreshTimers = new Map<string, NodeJS.Timeout>();
export const PTY_TREE_REFRESH_IDLE_MS = 1_500;
export const PTY_CWD_POLL_MS = 750;
let cwdPollTimer: NodeJS.Timeout | null = null;

const OSC7_RE = /\x1b\]7;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const OSC7_REMAINDER_MAX = 2_048;

function cwdFromOsc7Payload(payload: string): string | null {
  const trimmed = payload.trim();
  if (!trimmed.startsWith('file:')) {
    return null;
  }
  try {
    const url = new URL(trimmed);
    let pathname = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:/.test(pathname)) {
      pathname = pathname.slice(1);
    }
    return pathname.trim() || null;
  } catch {
    const m = trimmed.match(/^file:\/\/[^/]*(\/.*)$/);
    if (!m?.[1]) {
      return null;
    }
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }
}

function incompleteOsc7Remainder(tail: string): string {
  const start = tail.lastIndexOf('\x1b]7;');
  if (start >= 0) {
    return tail.slice(start, start + OSC7_REMAINDER_MAX);
  }
  if (tail.endsWith('\x1b]7')) {
    return '\x1b]7';
  }
  if (tail.endsWith('\x1b]')) {
    return '\x1b]';
  }
  if (tail.endsWith('\x1b')) {
    return '\x1b';
  }
  return '';
}

function consumeOsc7CwdChunk(
  remainder: string,
  chunk: string,
): { cwd: string | null; remainder: string } {
  const combined = `${remainder}${chunk}`;
  if (!combined.includes('\x1b')) {
    return { cwd: null, remainder: '' };
  }
  OSC7_RE.lastIndex = 0;
  let last: string | null = null;
  let lastCompleteEnd = 0;
  let match: RegExpExecArray | null = OSC7_RE.exec(combined);
  while (match) {
    const cwd = cwdFromOsc7Payload(match[1] ?? '');
    if (cwd) {
      last = cwd;
    }
    lastCompleteEnd = match.index + match[0].length;
    match = OSC7_RE.exec(combined);
  }
  return { cwd: last, remainder: incompleteOsc7Remainder(combined.slice(lastCompleteEnd)) };
}

function postWorkspacePtyToPython(urlPath: string, body: Record<string, unknown>): void {
  void pythonLogIngestFetch(urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {
    /* ignore sidecar offline / startup race */
  });
}

function isCurrentWatchedWorkspace(workspaceRoot: string): boolean {
  const watched = mainState.activeWorkspaceWatcher?.workspacePath?.trim() ?? '';
  if (!watched || !workspaceRoot.trim()) {
    return false;
  }
  return isSameWorkspaceRootPath(watched, workspaceRoot.trim());
}

function schedulePtyWorkspaceTreeRefresh(sessionId: string, workspaceRoot: string): void {
  const root = workspaceRoot.trim();
  if (!root || !isCurrentWatchedWorkspace(root)) {
    return;
  }
  const existing = ptyTreeRefreshTimers.get(sessionId);
  if (existing) {
    clearTimeout(existing);
  }
  ptyTreeRefreshTimers.set(
    sessionId,
    setTimeout(() => {
      ptyTreeRefreshTimers.delete(sessionId);
      void notifyWorkspaceTreeRefresh(root);
    }, PTY_TREE_REFRESH_IDLE_MS),
  );
}

function clearPtyWorkspaceTreeRefresh(sessionId: string): void {
  sessionWorkspaceRoots.delete(sessionId);
  sessionLastCwd.delete(sessionId);
  sessionMeta.delete(sessionId);
  osc7RemainderBySession.delete(sessionId);
  const timer = ptyTreeRefreshTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    ptyTreeRefreshTimers.delete(sessionId);
  }
}

/** Re-register live user PTY sessions with the Python sidecar after a sidecar restart. */
export function resyncWorkspacePtySessionsToPython(): void {
  for (const [sessionId, term] of sessions) {
    const workspaceRoot = sessionWorkspaceRoots.get(sessionId) ?? '';
    const cwd = sessionLastCwd.get(sessionId) ?? workspaceRoot;
    const meta = sessionMeta.get(sessionId);
    postWorkspacePtyToPython('/workspace-pty/register', {
      sessionId,
      workspaceRoot,
      cwd,
      shell: meta?.shell ?? '',
      pid: typeof term.pid === 'number' ? term.pid : null,
      cols: meta?.cols ?? 80,
      rows: meta?.rows ?? 24,
    });
  }
}

function pollPtySessionCwds(): void {
  for (const [sessionId, term] of sessions) {
    const cwd = readPtyProcessCwd(term.pid);
    if (!cwd || sessionLastCwd.get(sessionId) === cwd) {
      continue;
    }
    sessionLastCwd.set(sessionId, cwd);
    sendToMainRenderer('workspace-pty-cwd', { sessionId, cwd });
    postWorkspacePtyToPython('/workspace-pty/cwd', { sessionId, cwd });
  }
}

function ensureCwdPoller(): void {
  if (cwdPollTimer) {
    return;
  }
  cwdPollTimer = setInterval(() => {
    pollPtySessionCwds();
  }, PTY_CWD_POLL_MS);
  cwdPollTimer.unref();
}

function stopCwdPollerIfIdle(): void {
  if (sessions.size > 0) {
    return;
  }
  if (cwdPollTimer) {
    clearInterval(cwdPollTimer);
    cwdPollTimer = null;
  }
}

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
  const candidates: Array<{ file: string; args: string[] }> = [];
  if (shell && path.isAbsolute(shell)) {
    candidates.push({ file: shell, args: [] });
  }
  for (const file of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (!candidates.some((c) => c.file === file)) {
      candidates.push({ file, args: [] });
    }
  }
  if (shell && !path.isAbsolute(shell)) {
    candidates.push({ file: shell, args: [] });
  }
  if (candidates.length === 0) {
    candidates.push({ file: '/bin/bash', args: [] });
  }
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

/** Sessions torn down by kill-all — skip renderer IPC (window may already be destroyed). */
const disposingSessionIds = new Set<string>();

function sendToMainRenderer(channel: string, payload: unknown): void {
  const win = mainState.mainWindow;
  if (!win || win.isDestroyed()) {
    return;
  }
  try {
    win.webContents.send(channel, payload);
  } catch {
    /* window tearing down */
  }
}

function sendData(sessionId: string, data: string): void {
  sendToMainRenderer('workspace-pty-data', { sessionId, data });
}

function sendExit(sessionId: string, exitCode: number, signal: number | null): void {
  sendToMainRenderer('workspace-pty-exit', { sessionId, exitCode, signal });
}

/** Kill every workspace PTY (app quit or workspace switch). */
export function killAllWorkspacePtySessions(): void {
  const hadSessions = sessions.size > 0;
  for (const [sessionId] of sessions) {
    disposingSessionIds.add(sessionId);
    clearPtyWorkspaceTreeRefresh(sessionId);
  }
  for (const [, term] of sessions) {
    try {
      term.kill();
    } catch {
      /* ignore */
    }
  }
  sessions.clear();
  stopCwdPollerIfIdle();
  if (hadSessions) {
    postWorkspacePtyToPython('/workspace-pty/clear-all', {});
  }
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
        const safeCols = Math.max(2, Math.floor(colN));
        const safeRows = Math.max(1, Math.floor(rowN));
        const baseOpts: pty.IPtyForkOptions = {
          name: 'xterm-256color',
          cols: safeCols,
          rows: safeRows,
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
        sessionWorkspaceRoots.set(sessionId, wr.trim());
        sessionLastCwd.set(sessionId, cwdReal);
        sessionMeta.set(sessionId, { shell: file, cols: safeCols, rows: safeRows });
        ensureCwdPoller();
        postWorkspacePtyToPython('/workspace-pty/register', {
          sessionId,
          workspaceRoot: wr.trim(),
          cwd: cwdReal,
          shell: file,
          pid: typeof term.pid === 'number' ? term.pid : null,
          cols: safeCols,
          rows: safeRows,
        });
        term.onData((data) => {
          const osc = consumeOsc7CwdChunk(osc7RemainderBySession.get(sessionId) ?? '', data);
          osc7RemainderBySession.set(sessionId, osc.remainder);
          if (osc.cwd) {
            sessionLastCwd.set(sessionId, osc.cwd);
          }
          sendData(sessionId, data);
          postWorkspacePtyToPython('/workspace-pty/output', {
            sessionId,
            data,
            ...(osc.cwd ? { cwd: osc.cwd } : {}),
          });
        });
        term.onExit(({ exitCode, signal }) => {
          const quiet = disposingSessionIds.delete(sessionId);
          sessions.delete(sessionId);
          clearPtyWorkspaceTreeRefresh(sessionId);
          stopCwdPollerIfIdle();
          if (quiet) {
            return;
          }
          sendExit(sessionId, exitCode, signal ?? null);
          postWorkspacePtyToPython('/workspace-pty/exit', {
            sessionId,
            exitCode,
            removed: false,
          });
          if (isCurrentWatchedWorkspace(wr.trim())) {
            void notifyWorkspaceTreeRefresh(wr.trim());
          }
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

  ipcMain.on('workspace-pty-write', (event, sessionId: unknown, data: unknown) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      return;
    }
    const id = typeof sessionId === 'string' ? sessionId : '';
    const chunk = typeof data === 'string' ? data : '';
    const term = sessions.get(id);
    if (!term) {
      return;
    }
    try {
      term.write(chunk);
      const root = sessionWorkspaceRoots.get(id);
      if (root && (chunk.includes('\r') || chunk.includes('\n'))) {
        schedulePtyWorkspaceTreeRefresh(id, root);
      }
    } catch {
      /* session already dying */
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
    disposingSessionIds.add(id);
    try {
      term.kill();
      sessions.delete(id);
      clearPtyWorkspaceTreeRefresh(id);
      stopCwdPollerIfIdle();
      postWorkspacePtyToPython('/workspace-pty/exit', {
        sessionId: id,
        exitCode: null,
        removed: true,
      });
      return { success: true as const };
    } catch (err: unknown) {
      disposingSessionIds.delete(id);
      sessions.delete(id);
      clearPtyWorkspaceTreeRefresh(id);
      stopCwdPollerIfIdle();
      postWorkspacePtyToPython('/workspace-pty/exit', {
        sessionId: id,
        exitCode: null,
        removed: true,
      });
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
