import { promises as fs } from 'fs';
import path = require('path');

import type { ConversationTimelineInvertAction } from '../shared';
import { encodeWorkspaceFileContent, normalizeWorkspaceEncoding } from './utils/workspace-file-encoding';
import { resolveSafeWorkspacePath } from './utils/workspace-safe-path';
import { emitWorkspaceFilesChanged } from './workspace/emit-files-changed';

async function writeTextFile(
  workspaceRoot: string,
  relativePath: string,
  content: string,
  encoding?: string,
  newline?: 'lf' | 'crlf',
): Promise<string> {
  const enc = encoding?.trim() || 'utf-8';
  normalizeWorkspaceEncoding(enc);
  const nl = newline === 'crlf' ? 'crlf' : 'lf';
  const abs = resolveSafeWorkspacePath(workspaceRoot, relativePath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, encodeWorkspaceFileContent(content, enc, nl));
  return abs;
}

async function deletePath(workspaceRoot: string, relativePath: string): Promise<string | null> {
  const abs = resolveSafeWorkspacePath(workspaceRoot, relativePath);
  try {
    const stat = await fs.lstat(abs);
    if (stat.isDirectory()) {
      await fs.rm(abs, { recursive: true, force: true });
    } else {
      await fs.unlink(abs);
    }
    return abs;
  } catch (e) {
    const code = e && typeof e === 'object' && 'code' in e ? (e as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOENT') {
      return null;
    }
    throw e;
  }
}

/** Apply invert actions and notify the workspace watcher. */
export async function applyTimelineInvertActions(
  workspaceRoot: string,
  actions: readonly ConversationTimelineInvertAction[],
): Promise<{ revertedPaths: string[]; skippedPaths: string[] }> {
  const root = workspaceRoot.trim();
  const revertedPaths: string[] = [];
  const skippedPaths: string[] = [];
  const changedAbs: { abs: string; kind: 'updated' | 'created' | 'deleted' }[] = [];

  for (const action of actions) {
    try {
      if (action.kind === 'skip') {
        skippedPaths.push(action.relativePath);
        continue;
      }
      if (action.kind === 'delete') {
        const abs = await deletePath(root, action.relativePath);
        revertedPaths.push(action.relativePath);
        if (abs) {
          changedAbs.push({ abs, kind: 'deleted' });
        }
        continue;
      }
      if (action.kind === 'write') {
        const abs = await writeTextFile(
          root,
          action.relativePath,
          action.content,
          action.encoding,
          action.newline,
        );
        revertedPaths.push(action.relativePath);
        changedAbs.push({ abs, kind: 'updated' });
        continue;
      }
      for (const entry of action.entries) {
        const abs = await writeTextFile(root, entry.relativePath, entry.content, entry.encoding, entry.newline);
        revertedPaths.push(entry.relativePath);
        changedAbs.push({ abs, kind: 'created' });
      }
    } catch (e) {
      const pathLabel =
        action.kind === 'write-tree' ? action.entries[0]?.relativePath ?? '(tree)' : action.relativePath;
      skippedPaths.push(pathLabel);
      console.error('[ConversationTimeline] invert failed', pathLabel, e);
    }
  }

  for (const change of changedAbs) {
    try {
      await emitWorkspaceFilesChanged(root, change.abs, change.kind);
    } catch (e) {
      console.error('[ConversationTimeline] emit files-changed failed', e);
    }
  }

  return { revertedPaths: [...new Set(revertedPaths)], skippedPaths: [...new Set(skippedPaths)] };
}
