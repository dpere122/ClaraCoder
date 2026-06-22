import { promises as fs } from 'fs';
import path = require('path');

import { isAbsolutePathWithinWorkspaceRoot, resolveExistingOrResolvedPath } from './workspace-safe-path';

export function isPathStrictlyInside(parentAbs: string, childAbs: string): boolean {
  const parent = path.normalize(path.resolve(parentAbs));
  const child = path.normalize(path.resolve(childAbs));
  if (parent === child) {
    return false;
  }
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function validateWorkspaceEntryMove(sourceAbs: string, destParentAbs: string): string | null {
  const source = path.normalize(path.resolve(sourceAbs));
  const destParent = path.normalize(path.resolve(destParentAbs));
  const dest = path.normalize(path.resolve(destParent, path.basename(source)));

  if (source === dest) {
    return null;
  }
  if (destParent === source) {
    return 'Cannot move a folder into itself.';
  }
  if (isPathStrictlyInside(source, destParent)) {
    return 'Cannot move a folder into its own subfolder.';
  }
  return null;
}

async function moveEntryCrossPlatform(source: string, dest: string): Promise<void> {
  try {
    await fs.rename(source, dest);
    return;
  } catch (e) {
    const code = e && typeof e === 'object' && 'code' in e ? (e as NodeJS.ErrnoException).code : undefined;
    if (code !== 'EXDEV') {
      throw e;
    }
  }

  const stat = await fs.lstat(source);
  if (stat.isDirectory()) {
    await fs.cp(source, dest, { recursive: true });
    await fs.rm(source, { recursive: true, force: true });
    return;
  }
  await fs.copyFile(source, dest);
  await fs.unlink(source);
}

async function copyEntryRecursive(source: string, dest: string): Promise<void> {
  const stat = await fs.lstat(source);
  if (stat.isDirectory()) {
    await fs.cp(source, dest, { recursive: true });
    return;
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(source, dest);
}

export async function transferWorkspaceEntry(
  sourceRaw: string,
  destParentRaw: string,
  mode: 'move' | 'copy',
): Promise<{ dest: string }> {
  const source = path.resolve(sourceRaw.trim());
  const destParent = path.resolve(destParentRaw.trim());
  const dest = path.resolve(destParent, path.basename(source));

  const moveError = validateWorkspaceEntryMove(source, destParent);
  if (moveError) {
    throw new Error(moveError);
  }

  if (source === dest) {
    return { dest: source };
  }

  try {
    await fs.access(dest);
    throw new Error('An item with that name already exists in the destination folder.');
  } catch (e) {
    const code = e && typeof e === 'object' && 'code' in e ? (e as NodeJS.ErrnoException).code : undefined;
    if (code !== 'ENOENT') {
      if (e instanceof Error && e.message.includes('already exists')) {
        throw e;
      }
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(msg);
    }
  }

  if (mode === 'move') {
    await moveEntryCrossPlatform(source, dest);
  } else {
    await copyEntryRecursive(source, dest);
  }

  return { dest };
}

export async function resolveWorkspaceTransferPaths(
  workspaceRoot: string,
  sourceRaw: string,
  destParentRaw: string,
): Promise<{ root: string; source: string; destParent: string }> {
  const root = await resolveExistingOrResolvedPath(workspaceRoot);
  const sourceResolved = path.resolve(sourceRaw.trim());
  let source = sourceResolved;
  try {
    source = await fs.realpath(sourceResolved);
  } catch {
    source = sourceResolved;
  }
  const destParentResolved = path.resolve(destParentRaw.trim());
  let destParent = destParentResolved;
  try {
    destParent = await fs.realpath(destParentResolved);
  } catch {
    destParent = destParentResolved;
  }

  if (!isAbsolutePathWithinWorkspaceRoot(root, source)) {
    throw new Error('Cannot move paths outside the workspace.');
  }
  if (!isAbsolutePathWithinWorkspaceRoot(root, destParent)) {
    throw new Error('Destination folder outside workspace.');
  }

  return { root, source, destParent };
}

export function isSameWorkspaceRootPath(root: string, candidate: string): boolean {
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
