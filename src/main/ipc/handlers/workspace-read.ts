import { ipcMain } from 'electron';
import { promises as fs } from 'fs';

import { resolveSafeWorkspacePath } from '../../utils/workspace-safe-path';

const MAX_READ_BYTES = 5 * 1024 * 1024;

/** Read a UTF-8 text file under an open workspace (for the in-app Monaco editor). */
export function registerWorkspaceReadIpc(): void {
  ipcMain.handle('read-workspace-file', async (_event, workspaceRoot: string, relativePath: string) => {
    if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
      return { ok: false as const, error: 'No workspace root.' };
    }
    if (typeof relativePath !== 'string' || !relativePath.trim()) {
      return { ok: false as const, error: 'No relative path.' };
    }
    try {
      const abs = resolveSafeWorkspacePath(workspaceRoot.trim(), relativePath);
      const st = await fs.stat(abs);
      if (!st.isFile()) {
        return { ok: false as const, error: 'Not a file.' };
      }
      if (st.size > MAX_READ_BYTES) {
        return { ok: false as const, error: `File too large (max ${MAX_READ_BYTES} bytes).` };
      }
      const buf = await fs.readFile(abs);
      if (buf.includes(0)) {
        return { ok: false as const, error: 'Binary file not supported.' };
      }
      const content = buf.toString('utf8');
      return { ok: true as const, content, path: abs };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false as const, error: msg };
    }
  });
}
