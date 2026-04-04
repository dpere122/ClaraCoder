import { ipcMain } from 'electron';
import { promises as fs } from 'fs';
import path = require('path');

function resolveSafePath(workspaceRoot: string, relativePath: string): string {
  const root = path.resolve(workspaceRoot);
  const cleaned = relativePath.replace(/\\/g, '/').trim() || '.';
  const joined = path.resolve(root, cleaned);
  const rel = path.relative(root, joined);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Path escapes workspace');
  }
  return joined;
}

/** Write UTF-8 file under an open workspace (used after user confirms a proposed diff). */
export function registerWorkspaceWriteIpc(): void {
  ipcMain.handle(
    'write-workspace-file',
    async (_event, workspaceRoot: string, relativePath: string, utf8Content: string) => {
      if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
        return { ok: false as const, error: 'No workspace root.' };
      }
      if (typeof relativePath !== 'string' || !relativePath.trim()) {
        return { ok: false as const, error: 'No relative path.' };
      }
      if (typeof utf8Content !== 'string') {
        return { ok: false as const, error: 'Invalid content.' };
      }
      try {
        const abs = resolveSafePath(workspaceRoot.trim(), relativePath);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, utf8Content, 'utf-8');
        return { ok: true as const, path: abs };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false as const, error: msg };
      }
    },
  );
}
