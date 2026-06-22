import { dialog, ipcMain } from 'electron';
import { promises as fs } from 'fs';
import path = require('path');
import { randomUUID } from 'crypto';

import { assertTrustedMainRenderer } from '../assert-trusted-renderer';
import { encodeWorkspaceFileContent } from '../../utils/workspace-file-encoding';
import {
  isAbsolutePathWithinWorkspaceRoot,
  resolveExistingOrResolvedPath,
  resolveSafeWorkspacePath,
} from '../../utils/workspace-safe-path';
import { getEditorDetachedSnapshotsDir } from '../../paths';
import { mainState } from '../../state';
import { emitWorkspaceFilesChanged } from '../../workspace/emit-files-changed';

const MAX_READ_BYTES = 5 * 1024 * 1024;

function dialogParent() {
  const mw = mainState.mainWindow;
  return mw && !mw.isDestroyed() ? mw : undefined;
}

async function writeUtf8File(absPath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  const buf = encodeWorkspaceFileContent(content, 'utf-8', 'lf');
  await fs.writeFile(absPath, buf);
}

/** Detached editor snapshots, Save As, and absolute-path read/write for external tabs. */
export function registerWorkspaceEditorSnapshotIpc(): void {
  ipcMain.handle('workspace-file-exists', async (event, workspaceRoot: string, relativePath: string) => {
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
      return { ok: true as const, exists: true, isFile: st.isFile() };
    } catch (e) {
      const code = e && typeof e === 'object' && 'code' in e ? (e as NodeJS.ErrnoException).code : undefined;
      if (code === 'ENOENT') {
        return { ok: true as const, exists: false, isFile: false };
      }
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false as const, error: msg };
    }
  });

  ipcMain.handle('write-editor-detached-snapshot', async (event, content: string) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      return { ok: false as const, error: 'Forbidden' };
    }
    if (typeof content !== 'string') {
      return { ok: false as const, error: 'Invalid content.' };
    }
    try {
      const dir = getEditorDetachedSnapshotsDir();
      await fs.mkdir(dir, { recursive: true });
      const abs = path.join(dir, `${randomUUID()}.txt`);
      await writeUtf8File(abs, content);
      return { ok: true as const, path: abs };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false as const, error: msg };
    }
  });

  ipcMain.handle('delete-editor-detached-snapshot', async (event, absolutePath: string) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      return { ok: false as const, error: 'Forbidden' };
    }
    if (typeof absolutePath !== 'string' || !absolutePath.trim()) {
      return { ok: true as const };
    }
    const snapDir = path.resolve(getEditorDetachedSnapshotsDir());
    const target = path.resolve(absolutePath.trim());
    if (!isAbsolutePathWithinWorkspaceRoot(snapDir, target)) {
      return { ok: false as const, error: 'Path is not an editor snapshot.' };
    }
    try {
      await fs.unlink(target);
    } catch (e) {
      const code = e && typeof e === 'object' && 'code' in e ? (e as NodeJS.ErrnoException).code : undefined;
      if (code !== 'ENOENT') {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false as const, error: msg };
      }
    }
    return { ok: true as const };
  });

  ipcMain.handle(
    'prompt-save-editor-file',
    async (
      event,
      workspaceRoot: string,
      defaultRelativePath: string,
      content: string,
    ) => {
      try {
        assertTrustedMainRenderer(event);
      } catch {
        return { ok: false as const, error: 'Forbidden' };
      }
      if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
        return { ok: false as const, error: 'No workspace root.' };
      }
      if (typeof defaultRelativePath !== 'string' || !defaultRelativePath.trim()) {
        return { ok: false as const, error: 'No default path.' };
      }
      if (typeof content !== 'string') {
        return { ok: false as const, error: 'Invalid content.' };
      }

      const parent = dialogParent();
      if (!parent) {
        return { ok: false as const, error: 'No window.' };
      }

      let defaultPath: string;
      try {
        defaultPath = resolveSafeWorkspacePath(workspaceRoot.trim(), defaultRelativePath);
      } catch {
        defaultPath = path.join(path.resolve(workspaceRoot.trim()), path.basename(defaultRelativePath));
      }

      const result = await dialog.showSaveDialog(parent, {
        defaultPath,
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      });
      if (result.canceled || !result.filePath) {
        return { ok: false as const, cancelled: true as const };
      }

      const chosen = path.resolve(result.filePath);
      let rootReal: string;
      try {
        rootReal = await resolveExistingOrResolvedPath(workspaceRoot.trim());
      } catch {
        rootReal = path.resolve(workspaceRoot.trim());
      }

      try {
        await writeUtf8File(chosen, content);
        const inside = isAbsolutePathWithinWorkspaceRoot(rootReal, chosen);
        if (inside) {
          await emitWorkspaceFilesChanged(rootReal, chosen, 'updated');
          const rel = path.relative(rootReal, chosen).replace(/\\/g, '/');
          return {
            ok: true as const,
            absolutePath: chosen,
            relativePath: rel && rel !== '' ? rel : path.basename(chosen),
            outsideWorkspace: false as const,
          };
        }
        return { ok: true as const, absolutePath: chosen, outsideWorkspace: true as const };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false as const, error: msg };
      }
    },
  );

  ipcMain.handle('write-absolute-file', async (event, absolutePath: string, content: string) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      return { ok: false as const, error: 'Forbidden' };
    }
    if (typeof absolutePath !== 'string' || !absolutePath.trim()) {
      return { ok: false as const, error: 'No path.' };
    }
    if (typeof content !== 'string') {
      return { ok: false as const, error: 'Invalid content.' };
    }
    const abs = path.resolve(absolutePath.trim());
    try {
      const st = await fs.stat(abs);
      if (st.isDirectory()) {
        return { ok: false as const, error: 'Path is a directory.' };
      }
    } catch (e) {
      const code = e && typeof e === 'object' && 'code' in e ? (e as NodeJS.ErrnoException).code : undefined;
      if (code !== 'ENOENT') {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false as const, error: msg };
      }
    }
    try {
      await writeUtf8File(abs, content);
      return { ok: true as const, path: abs };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false as const, error: msg };
    }
  });

  ipcMain.handle('read-absolute-file', async (event, absolutePath: string) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      return { ok: false as const, error: 'Forbidden' };
    }
    if (typeof absolutePath !== 'string' || !absolutePath.trim()) {
      return { ok: false as const, error: 'No path.' };
    }
    const abs = path.resolve(absolutePath.trim());
    try {
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
      return { ok: true as const, content: buf.toString('utf8'), path: abs };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false as const, error: msg };
    }
  });
}
