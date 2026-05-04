/** Normalize slashes and trim; does not resolve `.` segments. */
export function normalizePathSlashes(p: string): string {
  return p.replace(/\\/g, '/').trim();
}

/**
 * If `absolutePath` is under `workspaceRoot`, return POSIX-style relative path; else null.
 */
export function workspaceRelativePathIfUnderRoot(workspaceRoot: string, absolutePath: string): string | null {
  const root = normalizePathSlashes(workspaceRoot).replace(/\/+$/, '');
  const abs = normalizePathSlashes(absolutePath).replace(/\/+$/, '');
  if (!root || !abs) {
    return null;
  }
  const rootLc = root.toLowerCase();
  const absLc = abs.toLowerCase();
  if (absLc === rootLc) {
    return '';
  }
  const prefix = rootLc + '/';
  if (!absLc.startsWith(prefix)) {
    return null;
  }
  const sliceLen = root.length + 1;
  return normalizePathSlashes(abs.slice(sliceLen));
}
