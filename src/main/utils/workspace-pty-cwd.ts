import { existsSync } from 'fs';

import { isAbsolutePathWithinWorkspaceRoot, resolveExistingOrResolvedPath } from './workspace-safe-path';

/**
 * Ensures a PTY cwd exists on disk and stays under the open workspace root (trust boundary).
 */
export async function validateWorkspacePtyCwd(
  workspaceRoot: string,
  cwd: string,
): Promise<{ ok: true; cwdReal: string } | { ok: false; error: string }> {
  const wr = typeof workspaceRoot === 'string' ? workspaceRoot.trim() : '';
  const cw = typeof cwd === 'string' ? cwd.trim() : '';
  if (!wr) {
    return { ok: false, error: 'Workspace root is required' };
  }
  if (!cw) {
    return { ok: false, error: 'Working directory is required' };
  }
  const workspaceRootReal = await resolveExistingOrResolvedPath(wr);
  const cwdReal = await resolveExistingOrResolvedPath(cw);
  if (!existsSync(cwdReal)) {
    return { ok: false, error: 'Invalid or missing workspace directory' };
  }
  if (!isAbsolutePathWithinWorkspaceRoot(workspaceRootReal, cwdReal)) {
    return { ok: false, error: 'Working directory must be inside the open workspace' };
  }
  return { ok: true, cwdReal };
}
