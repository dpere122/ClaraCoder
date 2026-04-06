import { ipcMain } from 'electron';
import { promises as fs } from 'fs';
import path = require('path');

import type { WorkspaceFileWriteOptions } from '../../../shared';
import { encodeWorkspaceFileContent, normalizeWorkspaceEncoding } from '../../utils/workspace-file-encoding';

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

/** Write a text file under an open workspace (used after user confirms a proposed diff). */
export function registerWorkspaceWriteIpc(): void {
  ipcMain.handle(
    'write-workspace-file',
    async (
      _event,
      workspaceRoot: string,
      relativePath: string,
      content: string,
      options?: WorkspaceFileWriteOptions,
    ) => {
      if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
        return { ok: false as const, error: 'No workspace root.' };
      }
      if (typeof relativePath !== 'string' || !relativePath.trim()) {
        return { ok: false as const, error: 'No relative path.' };
      }
      if (typeof content !== 'string') {
        return { ok: false as const, error: 'Invalid content.' };
      }
      const encoding = (options?.encoding ?? 'utf-8').trim() || 'utf-8';
      const newline = options?.newline === 'crlf' ? 'crlf' : 'lf';
      try {
        normalizeWorkspaceEncoding(encoding);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false as const, error: msg };
      }
      try {
        const abs = resolveSafePath(workspaceRoot.trim(), relativePath);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        const buf = encodeWorkspaceFileContent(content, encoding, newline);
        await fs.writeFile(abs, buf);
        return { ok: true as const, path: abs };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false as const, error: msg };
      }
    },
  );
}
