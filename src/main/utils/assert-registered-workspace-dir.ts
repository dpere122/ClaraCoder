import { promises as fs } from 'fs';
import { loadConfig } from '../config/load-save';
import { isAbsolutePathWithinWorkspaceRoot, resolveExistingOrResolvedPath } from './workspace-safe-path';

function rejectNullBytes(p: string): void {
  if (p.includes('\0')) {
    throw new Error('Invalid path characters');
  }
}

async function assertRegisteredWorkspacePath(
  absolutePath: string,
  options?: { requireDirectory?: boolean },
): Promise<string> {
  if (typeof absolutePath !== 'string' || !absolutePath.trim()) {
    throw new Error('Invalid path');
  }
  rejectNullBytes(absolutePath);
  const resolved = await resolveExistingOrResolvedPath(absolutePath.trim());
  const stat = await fs.stat(resolved);
  if (options?.requireDirectory && !stat.isDirectory()) {
    throw new Error('Not a directory');
  }
  const config = await loadConfig();
  for (const ws of config.workspaces ?? []) {
    const rootPath = ws.path?.trim();
    if (!rootPath) {
      continue;
    }
    rejectNullBytes(rootPath);
    const root = await resolveExistingOrResolvedPath(rootPath);
    if (isAbsolutePathWithinWorkspaceRoot(root, resolved)) {
      return resolved;
    }
  }
  throw new Error('Path is outside registered workspaces');
}

/**
 * Ensures `dirPath` is an existing directory under a workspace from app config.
 * Prevents arbitrary filesystem enumeration via IPC.
 */
export async function assertRegisteredWorkspaceDirectory(dirPath: string): Promise<string> {
  return assertRegisteredWorkspacePath(dirPath, { requireDirectory: true });
}

/** Ensures `absolutePath` is an existing file or directory under a registered workspace. */
export async function assertRegisteredWorkspaceEntry(absolutePath: string): Promise<string> {
  return assertRegisteredWorkspacePath(absolutePath);
}
