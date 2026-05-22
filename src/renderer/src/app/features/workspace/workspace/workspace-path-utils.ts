import { normalizePathSlashes } from '../../../utils/workspace-relative-path';

export function parentDirectoryPath(filePath: string): string {
  const trimmed = filePath.replace(/[/\\]+$/, '');
  const m = trimmed.match(/^(.+)[\\/][^\\/]+$/);
  return m ? m[1] : trimmed;
}

export function isSafeNewFileRelativeName(name: string): boolean {
  const parts = normalizePathSlashes(name)
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) {
    return false;
  }
  for (const p of parts) {
    if (p === '..' || p === '.') {
      return false;
    }
  }
  return true;
}

/** Single path segment only (rename in same folder). */
export function isSafeRenameBasename(name: string): boolean {
  const parts = normalizePathSlashes(name)
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length !== 1) {
    return false;
  }
  const p = parts[0];
  return p !== '..' && p !== '.';
}
