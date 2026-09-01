import { promises as fs } from 'fs';
import path = require('path');
import {
  LEGACY_WORKSPACE_META_DIR,
  WORKSPACE_BUILD_PLANS_DIR,
  WORKSPACE_BUILD_PLANS_REL_DIR,
  WORKSPACE_META_DIR,
} from '../../shared';

const LEGACY_BUILD_PLANS_PREFIX = `${LEGACY_WORKSPACE_META_DIR}/${WORKSPACE_BUILD_PLANS_DIR}/`;
const BUILD_PLANS_PREFIX = `${WORKSPACE_BUILD_PLANS_REL_DIR}/`;

export function rewriteLegacyBuildPlanRelativePath(relativePath: string): string {
  const n = (relativePath || '').replace(/\\/g, '/');
  if (n.startsWith(LEGACY_BUILD_PLANS_PREFIX)) {
    return BUILD_PLANS_PREFIX + n.slice(LEGACY_BUILD_PLANS_PREFIX.length);
  }
  if (n === `${LEGACY_WORKSPACE_META_DIR}/${WORKSPACE_BUILD_PLANS_DIR}`) {
    return WORKSPACE_BUILD_PLANS_REL_DIR;
  }
  return n;
}

async function rewriteBuildPlanIndexFile(indexPath: string): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(indexPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return;
    }
    throw err;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }
  if (!Array.isArray(data)) {
    return;
  }
  let changed = false;
  const rewritten = data.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      return entry;
    }
    const rec = entry as Record<string, unknown>;
    const rel = typeof rec.relativePath === 'string' ? rec.relativePath : '';
    const next = rewriteLegacyBuildPlanRelativePath(rel);
    if (next === rel) {
      return entry;
    }
    changed = true;
    return { ...rec, relativePath: next };
  });
  if (changed) {
    await fs.writeFile(indexPath, `${JSON.stringify(rewritten, null, 2)}\n`, 'utf8');
  }
}

/**
 * Rename `{root}/.nemo` → `{root}/.clara` when the target does not exist,
 * then rewrite `build-plans/index.json` relativePath values.
 * If both folders exist, leave `.nemo` in place (no merge).
 */
export async function migrateLegacyWorkspaceMetaDir(workspaceRoot: string): Promise<void> {
  const root = (workspaceRoot || '').trim();
  if (!root) {
    return;
  }
  const legacy = path.join(root, LEGACY_WORKSPACE_META_DIR);
  const current = path.join(root, WORKSPACE_META_DIR);
  try {
    const legacyStat = await fs.stat(legacy);
    if (legacyStat.isDirectory()) {
      try {
        await fs.access(current);
      } catch {
        await fs.rename(legacy, current);
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      console.warn('[workspace-meta] Failed to migrate legacy metadata dir:', err);
    }
  }
  try {
    await rewriteBuildPlanIndexFile(path.join(current, WORKSPACE_BUILD_PLANS_DIR, 'index.json'));
  } catch (err) {
    console.warn('[workspace-meta] Failed to rewrite build-plan index paths:', err);
  }
}
