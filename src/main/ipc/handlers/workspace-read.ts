import { ipcMain } from 'electron';
import { promises as fs } from 'fs';

import { assertTrustedMainRenderer } from '../assert-trusted-renderer';
import { resolveSafeWorkspacePath } from '../../utils/workspace-safe-path';

const MAX_READ_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

const IMAGE_MIME_BY_SUFFIX: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

function imageSuffix(relativePath: string): string {
  const lower = relativePath.toLowerCase();
  const dot = lower.lastIndexOf('.');
  return dot >= 0 ? lower.slice(dot) : '';
}

/** Read a UTF-8 text file under an open workspace (for the in-app Monaco editor). */
export function registerWorkspaceReadIpc(): void {
  ipcMain.handle('read-workspace-file', async (event, workspaceRoot: string, relativePath: string) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      return { ok: false as const, error: 'Forbidden' };
    }
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

  ipcMain.handle('read-workspace-image-base64', async (event, workspaceRoot: string, relativePath: string) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      return { ok: false as const, error: 'Forbidden' };
    }
    if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
      return { ok: false as const, error: 'No workspace root.' };
    }
    if (typeof relativePath !== 'string' || !relativePath.trim()) {
      return { ok: false as const, error: 'No relative path.' };
    }
    const suffix = imageSuffix(relativePath);
    const mime = IMAGE_MIME_BY_SUFFIX[suffix];
    if (!mime) {
      return { ok: false as const, error: 'Unsupported image type.' };
    }
    try {
      const abs = resolveSafeWorkspacePath(workspaceRoot.trim(), relativePath);
      const st = await fs.stat(abs);
      if (!st.isFile()) {
        return { ok: false as const, error: 'Not a file.' };
      }
      if (st.size > MAX_IMAGE_BYTES) {
        return { ok: false as const, error: `Image too large (max ${MAX_IMAGE_BYTES} bytes).` };
      }
      const buf = await fs.readFile(abs);
      const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
      return { ok: true as const, dataUrl, mime, path: abs };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false as const, error: msg };
    }
  });
}
