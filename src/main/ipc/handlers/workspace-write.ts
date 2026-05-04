import { ipcMain } from 'electron';
import { promises as fs } from 'fs';
import path = require('path');

import type { WorkspaceFileWriteOptions } from '../../../shared';
import { encodeWorkspaceFileContent, normalizeWorkspaceEncoding } from '../../utils/workspace-file-encoding';

function isSameWorkspaceRootPath(root: string, candidate: string): boolean {
  const a = path.normalize(root);
  const b = path.normalize(candidate);
  if (a === b) {
    return true;
  }
  if (process.platform === 'win32') {
    return a.toLowerCase() === b.toLowerCase();
  }
  return false;
}
import {
  isAbsolutePathWithinWorkspaceRoot,
  resolveExistingOrResolvedPath,
  resolveSafeWorkspacePath,
} from '../../utils/workspace-safe-path';

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
        const abs = resolveSafeWorkspacePath(workspaceRoot.trim(), relativePath);
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

  /**
   * Create an empty file under `absoluteParentDir` (from the tree) using Node path resolution so
   * Windows short/long path mismatches cannot block writes vs `workspaceRoot` from config.
   */
  ipcMain.handle(
    'create-workspace-file',
    async (_event, workspaceRoot: string, absoluteParentDir: string, fileName: string) => {
      if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
        return { ok: false as const, error: 'No workspace root.' };
      }
      if (typeof absoluteParentDir !== 'string' || !absoluteParentDir.trim()) {
        return { ok: false as const, error: 'No folder.' };
      }
      if (typeof fileName !== 'string' || !fileName.trim()) {
        return { ok: false as const, error: 'No file name.' };
      }
      const root = await resolveExistingOrResolvedPath(workspaceRoot);
      const parent = await resolveExistingOrResolvedPath(absoluteParentDir);
      const relName = fileName.trim().replace(/\\/g, '/').replace(/^\/+/, '');
      const segments = relName.split('/').filter((s) => s.length > 0);
      if (segments.length === 0) {
        return { ok: false as const, error: 'Invalid file name.' };
      }
      if (segments.some((s) => s === '.' || s === '..')) {
        return { ok: false as const, error: 'Invalid file name.' };
      }

      if (!isAbsolutePathWithinWorkspaceRoot(root, parent)) {
        return { ok: false as const, error: 'Folder outside workspace.' };
      }

      const absFile = path.resolve(parent, ...segments);
      if (!isAbsolutePathWithinWorkspaceRoot(root, absFile)) {
        return { ok: false as const, error: 'Path escapes workspace.' };
      }

      try {
        await fs.mkdir(path.dirname(absFile), { recursive: true });
        await fs.writeFile(absFile, '');
        return { ok: true as const, path: absFile };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false as const, error: msg };
      }
    },
  );

  /**
   * Create a folder under `absoluteParentDir` (same path rules as `create-workspace-file`).
   */
  ipcMain.handle(
    'create-workspace-folder',
    async (_event, workspaceRoot: string, absoluteParentDir: string, folderName: string) => {
      if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
        return { ok: false as const, error: 'No workspace root.' };
      }
      if (typeof absoluteParentDir !== 'string' || !absoluteParentDir.trim()) {
        return { ok: false as const, error: 'No folder.' };
      }
      if (typeof folderName !== 'string' || !folderName.trim()) {
        return { ok: false as const, error: 'No folder name.' };
      }
      const root = await resolveExistingOrResolvedPath(workspaceRoot);
      const parent = await resolveExistingOrResolvedPath(absoluteParentDir);
      const relName = folderName.trim().replace(/\\/g, '/').replace(/^\/+/, '');
      const segments = relName.split('/').filter((s) => s.length > 0);
      if (segments.length === 0) {
        return { ok: false as const, error: 'Invalid folder name.' };
      }
      if (segments.some((s) => s === '.' || s === '..')) {
        return { ok: false as const, error: 'Invalid folder name.' };
      }

      if (!isAbsolutePathWithinWorkspaceRoot(root, parent)) {
        return { ok: false as const, error: 'Folder outside workspace.' };
      }

      const absFolder = path.resolve(parent, ...segments);
      if (!isAbsolutePathWithinWorkspaceRoot(root, absFolder)) {
        return { ok: false as const, error: 'Path escapes workspace.' };
      }

      try {
        await fs.access(absFolder);
        return { ok: false as const, error: 'Already exists.' };
      } catch (e) {
        const code = e && typeof e === 'object' && 'code' in e ? (e as NodeJS.ErrnoException).code : undefined;
        if (code !== 'ENOENT') {
          const msg = e instanceof Error ? e.message : String(e);
          return { ok: false as const, error: msg };
        }
      }

      try {
        await fs.mkdir(absFolder, { recursive: true });
        return { ok: true as const, path: absFolder };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false as const, error: msg };
      }
    },
  );

  /** Delete a file or directory under the workspace (recursive for directories). */
  ipcMain.handle('delete-workspace-entry', async (_event, workspaceRoot: string, absolutePath: string) => {
    if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
      return { ok: false as const, error: 'No workspace root.' };
    }
    if (typeof absolutePath !== 'string' || !absolutePath.trim()) {
      return { ok: false as const, error: 'No path.' };
    }
    const root = await resolveExistingOrResolvedPath(workspaceRoot);
    const targetRaw = path.resolve(absolutePath.trim());
    let target = targetRaw;
    try {
      target = await fs.realpath(targetRaw);
    } catch {
      target = targetRaw;
    }
    if (!isAbsolutePathWithinWorkspaceRoot(root, target)) {
      return { ok: false as const, error: 'Cannot delete paths outside the workspace.' };
    }
    if (isSameWorkspaceRootPath(root, target)) {
      return { ok: false as const, error: 'Cannot delete the workspace root or paths outside it.' };
    }

    try {
      const stat = await fs.lstat(target);
      if (stat.isDirectory()) {
        await fs.rm(target, { recursive: true, force: true });
      } else {
        await fs.unlink(target);
      }
      return { ok: true as const, path: target };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false as const, error: msg };
    }
  });

  /** Rename a file or directory in place (`newName` is a single path segment; same parent folder). */
  ipcMain.handle(
    'rename-workspace-entry',
    async (_event, workspaceRoot: string, absolutePath: string, newName: string) => {
      if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
        return { ok: false as const, error: 'No workspace root.' };
      }
      if (typeof absolutePath !== 'string' || !absolutePath.trim()) {
        return { ok: false as const, error: 'No path.' };
      }
      if (typeof newName !== 'string' || !newName.trim()) {
        return { ok: false as const, error: 'No new name.' };
      }
      const root = await resolveExistingOrResolvedPath(workspaceRoot);
      const sourceRaw = path.resolve(absolutePath.trim());
      let source = sourceRaw;
      try {
        source = await fs.realpath(sourceRaw);
      } catch {
        source = sourceRaw;
      }
      if (!isAbsolutePathWithinWorkspaceRoot(root, source)) {
        return { ok: false as const, error: 'Cannot rename paths outside the workspace.' };
      }
      if (isSameWorkspaceRootPath(root, source)) {
        return { ok: false as const, error: 'Cannot rename the workspace root or paths outside it.' };
      }

      const base = newName.trim();
      if (base === '.' || base === '..' || base.includes('/') || base.includes('\\')) {
        return { ok: false as const, error: 'Invalid new name.' };
      }

      const parent = path.dirname(source);
      const dest = path.resolve(parent, base);

      let destForCheck = dest;
      try {
        destForCheck = await fs.realpath(dest);
      } catch {
        // Destination does not exist yet; resolved parent + basename is enough.
      }

      if (!isAbsolutePathWithinWorkspaceRoot(root, destForCheck)) {
        return { ok: false as const, error: 'Path escapes workspace.' };
      }

      if (path.relative(source, dest) === '') {
        return { ok: true as const, path: source };
      }

      try {
        await fs.rename(source, dest);
        return { ok: true as const, path: dest };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false as const, error: msg };
      }
    },
  );
}
