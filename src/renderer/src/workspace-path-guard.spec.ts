import { describe, expect, it } from 'vitest';

/**
 * POSIX subset of `isAbsolutePathWithinWorkspaceRoot` in `src/main/utils/workspace-safe-path.ts`.
 * (Windows drive-letter rules are covered by main integration; this guards prefix/sibling regressions.)
 */
function posixPathWithinWorkspaceRoot(workspaceRootReal: string, candidateAbs: string): boolean {
  const root = workspaceRootReal.trim().replace(/\/+$/, '') || '/';
  const cand = candidateAbs.trim();
  if (root === cand) {
    return true;
  }
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return cand.startsWith(prefix);
}

describe('posixPathWithinWorkspaceRoot (mirrors PTY cwd trust boundary)', () => {
  it('treats equal roots as inside', () => {
    expect(posixPathWithinWorkspaceRoot('/repo', '/repo')).toBe(true);
  });

  it('allows a subdirectory', () => {
    expect(posixPathWithinWorkspaceRoot('/repo', '/repo/src')).toBe(true);
  });

  it('rejects sibling paths', () => {
    expect(posixPathWithinWorkspaceRoot('/repo', '/other')).toBe(false);
  });

  it('rejects prefix tricks', () => {
    expect(posixPathWithinWorkspaceRoot('/repo', '/repo-evil')).toBe(false);
  });
});
