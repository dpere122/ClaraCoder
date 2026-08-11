/** Log files stay visible in workspace discovery even when gitignore or suffix rules apply. */

function stripLogSuffixes(entryName: string): string {
  const lower = entryName.toLowerCase();
  for (const suffix of ['.log.gz', '.log.bz2', '.log.xz', '.log.zip'] as const) {
    if (lower.endsWith(suffix)) {
      return entryName.slice(0, -suffix.length);
    }
  }
  const parts = lower.split('.');
  if (parts.length >= 3 && parts[parts.length - 2] === 'log' && /^\d+$/.test(parts[parts.length - 1] ?? '')) {
    // e.g. app.log.1 → app
    return parts.slice(0, -2).join('.');
  }
  if (lower.endsWith('.log')) {
    return entryName.slice(0, -4);
  }
  return entryName;
}

/** Secret-named bases that must not become force-visible via the log exception. */
function isSecretNamedLogBase(baseName: string): boolean {
  // Case-insensitive to match isAlwaysIgnoredWorkspaceEntry (e.g. .ENV.log, ID_RSA.log).
  const name = baseName.trim().toLowerCase();
  if (!name) {
    return false;
  }
  if (name === '.env' || name.startsWith('.env.')) {
    return true;
  }
  if (name === 'id_rsa' || name === 'id_ed25519' || name === 'credentials.json') {
    return true;
  }
  if (name.endsWith('.pem') || name.endsWith('.key') || name.endsWith('.p12') || name.endsWith('.pfx')) {
    return true;
  }
  return false;
}

export function isLogRelatedFile(entryName: string): boolean {
  const lower = entryName.toLowerCase();
  let isLog = false;
  if (lower.endsWith('.log')) {
    isLog = true;
  } else if (
    lower.endsWith('.log.gz') ||
    lower.endsWith('.log.bz2') ||
    lower.endsWith('.log.xz') ||
    lower.endsWith('.log.zip')
  ) {
    isLog = true;
  } else {
    const parts = lower.split('.');
    if (parts.length >= 3 && parts[parts.length - 2] === 'log' && /^\d+$/.test(parts[parts.length - 1] ?? '')) {
      isLog = true;
    }
  }
  if (!isLog) {
    return false;
  }

  // Do not override the secrets denylist for secret-named log files (e.g. `.env.log`, `id_rsa.log`).
  const base = stripLogSuffixes(entryName);
  if (isSecretNamedLogBase(entryName) || isSecretNamedLogBase(base) || isSecretNamedLogBase(pathBasename(base))) {
    return false;
  }
  return true;
}

function pathBasename(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1] || value;
}
