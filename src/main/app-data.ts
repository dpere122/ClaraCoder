/**
 * Stable on-disk app identity under the OS app-data root.
 *
 * Dev and packaged builds both use ``{appData}/clara-coder`` so config is not
 * scattered by Electron executable / productName changes. Legacy ``nemo-wrapper``
 * (and optional ``Clara Coder``) folders are migrated once on startup.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import path = require('path');

/** Canonical folder name under ``app.getPath('appData')``. Matches ``desktopName``. */
export const APP_DATA_DIR_NAME = 'clara-coder';

/**
 * Older data-dir names to migrate from (first match wins when the new dir is empty).
 * ``nemo-wrapper`` — historical package / hard-coded dev path.
 * ``Clara Coder`` — Electron ``userData`` when driven by ``productName`` / ``setName``.
 */
export const LEGACY_APP_DATA_DIR_NAMES = ['nemo-wrapper', 'Clara Coder'] as const;

const MIGRATION_MARKER = '.clara-coder-migrated-from';

export function resolveAppDataDir(appDataRoot: string): string {
  return path.join(appDataRoot, APP_DATA_DIR_NAME);
}

function dirHasEntries(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export type AppDataMigrationResult = {
  target: string;
  migrated: boolean;
  from?: string;
  method?: 'rename' | 'copy';
};

/**
 * Ensure ``{appDataRoot}/clara-coder`` exists, migrating the first non-empty legacy
 * directory when the target is missing or empty.
 */
export function migrateLegacyAppDataDir(appDataRoot: string): AppDataMigrationResult {
  const target = resolveAppDataDir(appDataRoot);

  if (dirHasEntries(target)) {
    return { target, migrated: false };
  }

  for (const legacyName of LEGACY_APP_DATA_DIR_NAMES) {
    const legacy = path.join(appDataRoot, legacyName);
    if (legacy === target || !isDirectory(legacy) || !dirHasEntries(legacy)) {
      continue;
    }

    mkdirSync(path.dirname(target), { recursive: true });

    try {
      renameSync(legacy, target);
      writeFileSync(path.join(target, MIGRATION_MARKER), `${legacyName}\n`, 'utf-8');
      return { target, migrated: true, from: legacy, method: 'rename' };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EACCES') {
        console.error(`[app-data] Failed to rename ${legacy} → ${target}:`, err);
        // Fall through to copy attempt for other rename failures on some platforms.
      }
    }

    try {
      mkdirSync(target, { recursive: true });
      cpSync(legacy, target, { recursive: true, force: true });
      writeFileSync(path.join(target, MIGRATION_MARKER), `${legacyName}\n`, 'utf-8');
      // Leave legacy in place as a safety net; next launches see a non-empty target.
      return { target, migrated: true, from: legacy, method: 'copy' };
    } catch (copyErr) {
      console.error(`[app-data] Failed to copy ${legacy} → ${target}:`, copyErr);
      try {
        if (existsSync(target) && !dirHasEntries(target)) {
          rmSync(target, { recursive: true, force: true });
        }
      } catch {
        /* ignore cleanup */
      }
    }
  }

  mkdirSync(target, { recursive: true });
  return { target, migrated: false };
}
