import { promises as fs, realpathSync } from 'fs';
import path = require('path');

function rejectNullBytes(value: string, label: string): void {
  if (value.includes('\0')) {
    throw new Error(`Invalid ${label}`);
  }
}

/**
 * True when `candidateAbs` is the workspace root or a path under it (normalized).
 * Prefer over `path.relative` alone: on Windows, drive-letter and short-name edge cases can make
 * `relative` look like an escape when paths are still inside the same folder.
 */
export function isAbsolutePathWithinWorkspaceRoot(workspaceRootReal: string, candidateAbs: string): boolean {
  rejectNullBytes(workspaceRootReal, 'path');
  rejectNullBytes(candidateAbs, 'path');
  const root = path.normalize(path.resolve(workspaceRootReal.trim()));
  const cand = path.normalize(path.resolve(candidateAbs.trim()));
  if (root === cand) {
    return true;
  }
  const sep = path.sep;
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (process.platform === 'win32') {
    const pl = prefix.toLowerCase();
    const cl = cand.toLowerCase();
    return cl.startsWith(pl);
  }
  return cand.startsWith(prefix);
}

/** Canonical directory path when present; otherwise `path.resolve` (e.g. race or missing path). */
export async function resolveExistingOrResolvedPath(dirPath: string): Promise<string> {
  rejectNullBytes(dirPath, 'path');
  const resolved = path.resolve(dirPath.trim());
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

function resolveRootOrResolved(workspaceRoot: string): string {
  rejectNullBytes(workspaceRoot, 'path');
  const resolved = path.resolve(workspaceRoot.trim());
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** Resolve `relativePath` under `workspaceRoot` or throw if it escapes the root. */
export function resolveSafeWorkspacePath(workspaceRoot: string, relativePath: string): string {
  rejectNullBytes(relativePath, 'path');
  const root = resolveRootOrResolved(workspaceRoot);
  const cleaned = relativePath.replace(/\\/g, '/').trim() || '.';
  const joined = path.resolve(root, cleaned);
  if (!isAbsolutePathWithinWorkspaceRoot(root, joined)) {
    throw new Error('Path escapes workspace');
  }
  return joined;
}
