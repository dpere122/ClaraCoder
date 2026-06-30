import {
  WORKSPACE_TREE_DRAG_IS_DIRECTORY_MIME,
  WORKSPACE_TREE_DRAG_MIME,
  WORKSPACE_TREE_INTERNAL_MOVE_MIME,
} from './chat-context-file';
import { normalizePathSlashes } from '../../../utils/workspace-relative-path';

/** Absolute path resolved from a chat-context drop, with optional directory hint. */
export interface ChatContextDroppedPath {
  absolutePath: string;
  isDirectory?: boolean;
}

type ElectronFile = File & { path?: string };

/** True when a drag carries workspace paths the chat context bar can accept. */
export function canAcceptChatContextDrop(event: DragEvent): boolean {
  const dt = event.dataTransfer;
  if (!dt) {
    return false;
  }
  const types = Array.from(dt.types ?? []);
  if (types.includes(WORKSPACE_TREE_DRAG_MIME) || types.includes('text/plain')) {
    return true;
  }
  if (types.includes('Files')) {
    if (dt.files.length > 0) {
      return true;
    }
    for (const item of Array.from(dt.items ?? [])) {
      if (item.kind !== 'file') {
        continue;
      }
      const entry = item.webkitGetAsEntry?.();
      if (entry?.isDirectory) {
        return true;
      }
    }
  }
  return false;
}

/** Match dropEffect to the drag source so dragover preventDefault is honored (folder tree drags use move-only). */
export function resolveChatContextDropEffect(dt: DataTransfer): DataTransfer['dropEffect'] {
  if (dt.types.includes(WORKSPACE_TREE_INTERNAL_MOVE_MIME)) {
    const allowed = dt.effectAllowed;
    if (allowed === 'move') {
      return 'move';
    }
    if (allowed === 'copy' || allowed === 'copyMove' || allowed === 'copyLink') {
      return 'copy';
    }
    if (allowed.includes('copy')) {
      return 'copy';
    }
    if (allowed.includes('move')) {
      return 'move';
    }
  }
  return 'copy';
}

/** Call from dragover handlers; returns true when the drop target should accept the drag. */
export function handleChatContextDragOver(event: DragEvent): boolean {
  if (!canAcceptChatContextDrop(event) || !event.dataTransfer) {
    return false;
  }
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer.dropEffect = resolveChatContextDropEffect(event.dataTransfer);
  return true;
}

/** Call from drop handlers after a successful dragover sequence. */
export function handleChatContextDrop(event: DragEvent): ChatContextDroppedPath[] {
  if (!canAcceptChatContextDrop(event)) {
    return [];
  }
  event.preventDefault();
  event.stopPropagation();
  return pathsFromChatContextDrop(event);
}

/** Resolve absolute paths from a chat-context drop (tree drag or OS file explorer). */
export function pathsFromChatContextDrop(event: DragEvent): ChatContextDroppedPath[] {
  const dt = event.dataTransfer;
  if (!dt) {
    return [];
  }

  const treePaths = pathsFromTreeDrag(dt);
  if (treePaths.length > 0) {
    return dedupeDroppedPaths(treePaths);
  }

  return dedupeDroppedPaths(pathsFromOsDrop(dt));
}

function pathsFromTreeDrag(dt: DataTransfer): ChatContextDroppedPath[] {
  const raw = dt.getData(WORKSPACE_TREE_DRAG_MIME) || dt.getData('text/plain');
  if (!raw.trim()) {
    return [];
  }
  const isDirectory = dt.getData(WORKSPACE_TREE_DRAG_IS_DIRECTORY_MIME) === '1';
  return raw
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((absolutePath) => ({ absolutePath, isDirectory }));
}

function pathsFromOsDrop(dt: DataTransfer): ChatContextDroppedPath[] {
  const filePaths = collectElectronFilePaths(dt);
  const items = Array.from(dt.items ?? []);
  const results: ChatContextDroppedPath[] = [];

  for (const item of items) {
    if (item.kind !== 'file') {
      continue;
    }
    const entry = item.webkitGetAsEntry?.() ?? null;
    if (entry?.isDirectory) {
      const absolutePath = resolveDirectoryDropPath(entry.name, filePaths, item);
      if (absolutePath) {
        results.push({ absolutePath, isDirectory: true });
      }
      continue;
    }
    if (entry?.isFile) {
      const file = item.getAsFile() as ElectronFile | null;
      const absolutePath = file?.path?.trim();
      if (absolutePath) {
        results.push({ absolutePath, isDirectory: false });
      }
    }
  }

  if (results.length === 0) {
    for (const absolutePath of filePaths) {
      results.push({ absolutePath, isDirectory: false });
    }
  }

  return results;
}

function collectElectronFilePaths(dt: DataTransfer): string[] {
  const paths: string[] = [];
  for (let i = 0; i < dt.files.length; i++) {
    const file = dt.files[i] as ElectronFile;
    const absolutePath = file.path?.trim();
    if (absolutePath) {
      paths.push(absolutePath);
    }
  }
  return paths;
}

function resolveDirectoryDropPath(
  entryName: string,
  nestedFilePaths: readonly string[],
  item: DataTransferItem,
): string | null {
  const file = item.getAsFile() as ElectronFile | null;
  const directPath = file?.path?.trim();
  if (nestedFilePaths.length === 0) {
    return directPath ?? null;
  }

  const commonDir = longestCommonDirectoryPrefix(nestedFilePaths);
  if (commonDir && pathBasename(commonDir) === entryName) {
    return commonDir;
  }
  if (commonDir && nestedFilePaths.every((p) => isPathInsideDirectory(commonDir, p))) {
    return commonDir;
  }
  return directPath ?? commonDir;
}

/** Longest directory prefix shared by all paths (POSIX-normalized for comparison). */
export function longestCommonDirectoryPrefix(paths: readonly string[]): string | null {
  if (paths.length === 0) {
    return null;
  }
  const normalized = paths.map((p) => normalizePathSlashes(p));
  let prefix = normalized[0]!;
  for (let i = 1; i < normalized.length; i++) {
    prefix = commonStringPrefix(prefix, normalized[i]!);
    if (!prefix) {
      return null;
    }
  }

  let dir = trimToDirectoryPrefix(prefix, normalized[0]!);
  while (dir) {
    if (normalized.every((p) => isPathInsideDirectory(dir!, p))) {
      return dir;
    }
    const slash = dir.lastIndexOf('/');
    if (slash <= 0) {
      break;
    }
    dir = dir.slice(0, slash);
  }
  return null;
}

function trimToDirectoryPrefix(prefix: string, firstPath: string): string {
  if (prefix === firstPath) {
    const slash = prefix.lastIndexOf('/');
    return slash > 0 ? prefix.slice(0, slash) : prefix;
  }
  const slash = prefix.lastIndexOf('/');
  return slash > 0 ? prefix.slice(0, slash) : prefix;
}

function commonStringPrefix(a: string, b: string): string {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) {
    i++;
  }
  return a.slice(0, i);
}

function isPathInsideDirectory(dir: string, candidate: string): boolean {
  const root = normalizePathSlashes(dir).replace(/\/+$/, '');
  const path = normalizePathSlashes(candidate);
  if (path === root) {
    return true;
  }
  return path.startsWith(`${root}/`);
}

function pathBasename(p: string): string {
  const normalized = normalizePathSlashes(p).replace(/\/+$/, '');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

function dedupeDroppedPaths(paths: readonly ChatContextDroppedPath[]): ChatContextDroppedPath[] {
  const seen = new Set<string>();
  const out: ChatContextDroppedPath[] = [];
  for (const entry of paths) {
    const key = `${entry.isDirectory ? 'd' : 'f'}:${normalizePathSlashes(entry.absolutePath)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(entry);
  }
  return out;
}
