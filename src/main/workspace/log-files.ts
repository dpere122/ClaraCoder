/** Log files stay visible in workspace discovery even when gitignore or suffix rules apply. */

export function isLogRelatedFile(entryName: string): boolean {
  const lower = entryName.toLowerCase();
  if (lower.endsWith('.log')) {
    return true;
  }
  if (lower.endsWith('.log.gz') || lower.endsWith('.log.bz2') || lower.endsWith('.log.xz') || lower.endsWith('.log.zip')) {
    return true;
  }
  const parts = lower.split('.');
  if (parts.length >= 3 && parts[parts.length - 2] === 'log' && /^\d+$/.test(parts[parts.length - 1] ?? '')) {
    return true;
  }
  return false;
}
