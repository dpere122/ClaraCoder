import { readlinkSync } from 'fs';

/**
 * Best-effort filesystem cwd for a PTY shell pid.
 * Linux uses `/proc/<pid>/cwd`; other platforms return null (OSC 7 still updates titles).
 */
export function readPtyProcessCwd(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  if (process.platform !== 'linux') {
    return null;
  }
  try {
    const cwd = readlinkSync(`/proc/${pid}/cwd`);
    return cwd.trim() || null;
  } catch {
    return null;
  }
}
