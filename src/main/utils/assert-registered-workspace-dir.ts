import { promises as fs } from 'fs';
import { loadConfig } from '../config/load-save';
import { isAbsolutePathWithinWorkspaceRoot, resolveExistingOrResolvedPath } from './workspace-safe-path';

function rejectNullBytes(p: string): void {
  if (p.includes('\0')) {
    throw new Error('Invalid path characters');
  }
}

/**
 * Ensures `dirPath` is an existing directory under a workspace from app config.
 * Prevents arbitrary filesystem enumeration via IPC.
 */
export async function assertRegisteredWorkspaceDirectory(dirPath: string): Promise<string> {
  if (typeof dirPath !== 'string' || !dirPath.trim()) {
    throw new Error('Invalid directory path');
  }
  rejectNullBytes(dirPath);
  const resolved = await resolveExistingOrResolvedPath(dirPath.trim());
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
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
  throw new Error('Directory is outside registered workspaces');
}
