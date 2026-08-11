import { promises as fs } from 'fs';
import path = require('path');
import type { WorkspaceChangeRecord, WorkspaceContextState } from '../../shared';
import { WORKSPACE_CONTEXT_MAX_DEPTH, WORKSPACE_CONTEXT_MAX_ENTRIES, WORKSPACE_NODE_MODULES_DIR } from '../constants';
import {
  isAlwaysIgnoredWorkspaceEntry,
  loadWorkspaceIgnoreRules,
  normalizeContextPath,
  shouldIgnoreWorkspaceEntry,
} from './ignore-rules';

export function formatContextTruncationNotice(prefix: string, reason: string): string {
  return `${prefix}... [${reason}]\n`;
}

export function formatWorkspaceStateSummary(lastSyncedAt: string | null, recentChanges: WorkspaceChangeRecord[]): string {
  if (!lastSyncedAt && recentChanges.length === 0) {
    return 'No watched filesystem activity has been recorded for this workspace in the current app session.';
  }

  const lines = ['Workspace filesystem state summary:'];

  if (lastSyncedAt) {
    lines.push(`- Last workspace tree refresh: ${lastSyncedAt}`);
  } else {
    lines.push('- Last workspace tree refresh: unavailable');
  }

  if (recentChanges.length === 0) {
    lines.push('- Recent filesystem activity: none recorded yet.');
  } else {
    lines.push('- Recent filesystem activity:');
    for (const change of recentChanges) {
      const kindSummary = change.kinds.join(', ');
      const pathSummary = change.paths.join(', ');
      lines.push(`  - ${change.changedAt}: [${kindSummary}] ${pathSummary}`);
    }
  }

  lines.push('Treat this as live workspace state metadata that may be newer than the conversation history.');
  return lines.join('\n');
}

/**
 * Renders a bounded tree listing under `dirPath` for LLM workspace context.
 */
export async function buildWorkspaceTree(
  dirPath: string,
  prefix = '',
  depth = 0,
  state?: WorkspaceContextState,
): Promise<string> {
  const contextState =
    state ??
    ({
      rootPath: dirPath,
      maxDepth: WORKSPACE_CONTEXT_MAX_DEPTH,
      maxEntries: WORKSPACE_CONTEXT_MAX_ENTRIES,
      entriesWritten: 0,
      truncated: false,
      ignoreRules: await loadWorkspaceIgnoreRules(dirPath),
      exposeAllWorkspaceFiles: false,
    } as WorkspaceContextState);

  if (depth >= contextState.maxDepth) {
    return formatContextTruncationNotice(prefix, `depth limit ${contextState.maxDepth}`);
  }

  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (err: unknown) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as { code: string }).code : '';
    if (code === 'EACCES' || code === 'EPERM') {
      return `${prefix}[permission denied]\n`;
    }
    throw err;
  }

  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const visibleEntries: typeof entries = [];
  for (const entry of entries) {
    const relativePath = path.relative(contextState.rootPath, path.join(dirPath, entry.name));
    // Secrets denylist: never list always-ignored entries, even when exposeAll is on.
    if (isAlwaysIgnoredWorkspaceEntry(entry.name, relativePath)) {
      continue;
    }
    if (
      shouldIgnoreWorkspaceEntry(
        entry.name,
        relativePath,
        contextState.ignoreRules,
        contextState.exposeAllWorkspaceFiles,
      )
    ) {
      continue;
    }
    // File symlink with innocent name can still point at a denylist target — resolve and check.
    if (entry.isSymbolicLink()) {
      const fullPath = path.join(dirPath, entry.name);
      try {
        const targetPath = await fs.realpath(fullPath);
        const targetBase = path.basename(targetPath);
        if (isAlwaysIgnoredWorkspaceEntry(targetBase, targetBase)) {
          continue;
        }
      } catch {
        // Broken / unresolvable symlink: keep name-based checks only.
      }
    }
    visibleEntries.push(entry);
  }

  let result = '';
  for (let i = 0; i < visibleEntries.length; i++) {
    const entry = visibleEntries[i];

    if (contextState.entriesWritten >= contextState.maxEntries) {
      if (!contextState.truncated) {
        contextState.truncated = true;
        result += formatContextTruncationNotice(prefix, `truncated after ${contextState.maxEntries} entries`);
      }
      break;
    }

    const isLast = i === visibleEntries.length - 1;
    const connector = isLast ? '`-- ' : '|-- ';
    const nextPrefix = prefix + (isLast ? '   ' : '|  ');
    const fullPath = path.join(dirPath, entry.name);
    const isSymlink = entry.isSymbolicLink();
    contextState.entriesWritten += 1;

    if (entry.isDirectory()) {
      result += `${prefix}${connector}${entry.name}/\n`;
      if (isSymlink) {
        result += `${nextPrefix}[symlink skipped]\n`;
        continue;
      }
      if (entry.name === WORKSPACE_NODE_MODULES_DIR) {
        result += `${nextPrefix}[bulk listing disabled — use search_workspace]\n`;
        continue;
      }
      result += await buildWorkspaceTree(fullPath, nextPrefix, depth + 1, contextState);
    } else {
      result += `${prefix}${connector}${entry.name}${isSymlink ? ' [symlink]' : ''}\n`;
    }
  }

  return result;
}

export { normalizeContextPath };
