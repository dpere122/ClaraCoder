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

/**
 * Secret / credential paths that stay hidden even when exposeAll is on.
 * Applied before the exposeAll bypass. Kept local to this module (not shared constants).
 */
const WORKSPACE_ALWAYS_IGNORED_NAMES = new Set([
  '.env',
  'id_rsa',
  'id_ed25519',
  'credentials.json',
]);

const WORKSPACE_ALWAYS_IGNORED_DIR_NAMES = new Set(['.git']);

const WORKSPACE_ALWAYS_IGNORED_SUFFIXES = ['.pem', '.key', '.p12', '.pfx'];

function stripIgnoreNegation(rule: string): { pattern: string; negated: boolean } {
  if (rule.startsWith('!')) {
    return { pattern: rule.slice(1), negated: true };
  }
  return { pattern: rule, negated: false };
}

/** True for always-denied secret/credential workspace entries (denylist). */
export function isAlwaysIgnoredWorkspaceEntry(entryName: string, relativePath: string): boolean {
  // Case-insensitive: APFS/NTFS treat .ENV / ID_RSA / key.PEM as the same secrets.
  const normalized = normalizeContextPath(relativePath).replace(/^\/+/, '').replace(/\/+$/, '');
  const segments = normalized ? normalized.split('/').map((s) => s.toLowerCase()) : [];
  const name = (entryName || segments[segments.length - 1] || '').toLowerCase();

  if (WORKSPACE_ALWAYS_IGNORED_DIR_NAMES.has(name) || segments.some((s) => WORKSPACE_ALWAYS_IGNORED_DIR_NAMES.has(s))) {
    return true;
  }

  if (WORKSPACE_ALWAYS_IGNORED_NAMES.has(name)) {
    return true;
  }

  // `.env.*` (e.g. `.env.local`, `.env.production`)
  if (name === '.env' || name.startsWith('.env.')) {
    return true;
  }

  if (WORKSPACE_ALWAYS_IGNORED_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    return true;
  }

  // Also catch denylisted basenames anywhere in the relative path (e.g. `secrets/credentials.json`).
  if (segments.some((segment) => WORKSPACE_ALWAYS_IGNORED_NAMES.has(segment) || segment.startsWith('.env.'))) {
    return true;
  }
  if (segments.some((segment) => WORKSPACE_ALWAYS_IGNORED_SUFFIXES.some((suffix) => segment.endsWith(suffix)))) {
    return true;
  }

  return false;
}

/** Load `.gitignore` lines from the workspace root (supports `!` negation rules). */
export async function loadWorkspaceIgnoreRules(rootPath: string): Promise<string[]> {
  const ignorePath = path.join(rootPath, '.gitignore');
  try {
    const raw = await fs.readFile(ignorePath, 'utf-8');
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  } catch {
    return [];
  }
}

export function matchesIgnoreRule(relativePath: string, entryName: string, rule: string): boolean {
  const { pattern } = stripIgnoreNegation(rule);
  const normalizedPath = normalizeContextPath(relativePath);
  const normalizedRule = normalizeContextPath(pattern);

  if (!normalizedRule) return false;

  if (normalizedRule.endsWith('/')) {
    // Gitignore `/runtime-bundle/` is anchored; strip the leading slash so we match
    // `runtime-bundle/...` rather than looking for a path that starts with `/runtime-bundle`.
    const anchored = normalizedRule.startsWith('/');
    const dirRule = normalizedRule.slice(0, -1).replace(/^\/+/, '');
    if (!dirRule) {
      return false;
    }
    const pathHit = normalizedPath === dirRule || normalizedPath.startsWith(`${dirRule}/`);
    if (anchored) {
      return pathHit;
    }
    return pathHit || entryName === dirRule;
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

function matchesGitignoreWithNegation(
  relativePath: string,
  entryName: string,
  ignoreRules: string[],
): boolean {
  const positiveRules = ignoreRules.filter((rule) => !rule.startsWith('!'));
  const negationRules = ignoreRules.filter((rule) => rule.startsWith('!'));

  const ignoredByPositive = positiveRules.some((rule) =>
    matchesIgnoreRule(relativePath, entryName, rule),
  );
  if (!ignoredByPositive) {
    return false;
  }

  // Negation re-includes after positive matches.
  const reIncluded = negationRules.some((rule) => matchesIgnoreRule(relativePath, entryName, rule));
  return !reIncluded;
}

export function shouldIgnoreWorkspaceEntry(
  entryName: string,
  relativePath: string,
  ignoreRules: string[],
  exposeAllWorkspaceFiles = false,
): boolean {
  // Denylist wins over exposeAll and over log force-visibility.
  if (isAlwaysIgnoredWorkspaceEntry(entryName, relativePath)) {
    return true;
  }
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
  return matchesGitignoreWithNegation(relativePath, entryName, ignoreRules);
}

export { isUnderNodeModules };
