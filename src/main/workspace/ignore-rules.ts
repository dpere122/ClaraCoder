import { promises as fs } from 'fs';
import path = require('path');
import {
  WORKSPACE_CONTEXT_IGNORED_NAMES,
  WORKSPACE_CONTEXT_IGNORED_SUFFIXES,
  WORKSPACE_NODE_MODULES_DIR,
} from '../constants';
import { isLogRelatedFile } from './log-files';

/** Normalize path separators for consistent ignore matching on Windows. */
export function normalizeContextPath(targetPath: string): string {
  return targetPath.replace(/\\/g, '/');
}

/** Load `.gitignore` lines from the workspace root (simple subset: no negation). */
export async function loadWorkspaceIgnoreRules(rootPath: string): Promise<string[]> {
  const ignorePath = path.join(rootPath, '.gitignore');
  try {
    const raw = await fs.readFile(ignorePath, 'utf-8');
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'));
  } catch {
    return [];
  }
}

export function matchesIgnoreRule(relativePath: string, entryName: string, rule: string): boolean {
  const normalizedPath = normalizeContextPath(relativePath);
  const normalizedRule = normalizeContextPath(rule);

  if (!normalizedRule) return false;

  if (normalizedRule.endsWith('/')) {
    const dirRule = normalizedRule.slice(0, -1);
    return normalizedPath === dirRule || normalizedPath.startsWith(`${dirRule}/`) || entryName === dirRule;
  }

  if (normalizedRule.startsWith('*.')) {
    return entryName.endsWith(normalizedRule.slice(1));
  }

  if (!normalizedRule.includes('/')) {
    return entryName === normalizedRule || normalizedPath.split('/').includes(normalizedRule);
  }

  const anchoredRule = normalizedRule.startsWith('/') ? normalizedRule.slice(1) : normalizedRule;
  return normalizedPath === anchoredRule || normalizedPath.startsWith(`${anchoredRule}/`);
}

function isUnderNodeModules(relativePath: string): boolean {
  const normalized = normalizeContextPath(relativePath).replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalized) {
    return false;
  }
  return normalized.split('/').includes(WORKSPACE_NODE_MODULES_DIR);
}

export function shouldIgnoreWorkspaceEntry(
  entryName: string,
  relativePath: string,
  ignoreRules: string[],
  exposeAllWorkspaceFiles = false,
): boolean {
  if (isLogRelatedFile(entryName)) {
    return false;
  }
  const normalized = normalizeContextPath(relativePath).replace(/^\/+/, '').replace(/\/+$/, '');
  const segments = normalized ? normalized.split('/') : [];
  if (segments.includes(WORKSPACE_NODE_MODULES_DIR)) {
    if (segments.length === 1 && entryName === WORKSPACE_NODE_MODULES_DIR) {
      return false;
    }
    return true;
  }
  if (exposeAllWorkspaceFiles) {
    return false;
  }
  if (WORKSPACE_CONTEXT_IGNORED_NAMES.has(entryName)) {
    return true;
  }
  if (WORKSPACE_CONTEXT_IGNORED_SUFFIXES.some((suffix) => entryName.endsWith(suffix))) {
    return true;
  }
  return ignoreRules.some((rule) => matchesIgnoreRule(relativePath, entryName, rule));
}

export { isUnderNodeModules };
