import type { WorkspaceFilesChangedMessage } from '@shared/index';
import { normalizePathSlashes } from '../../../utils/workspace-relative-path';

export type WorkspaceChangeKind = 'created' | 'updated' | 'deleted' | 'renamed' | 'unknown';

export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  expanded: boolean;
  children: FileNode[] | null;
  depth: number;
}

export interface FlatNode {
  name: string;
  path: string;
  isDirectory: boolean;
  expanded: boolean;
  depth: number;
  hasChildren: boolean;
}

/** Sentinel path for the inline “new file / folder” row injected into the flat tree. */
export const PENDING_CREATE_TREE_PATH = '\0__pending_create__';

export function isPendingCreateTreeNode(node: FlatNode): boolean {
  return node.path === PENDING_CREATE_TREE_PATH;
}

/** Insert index and depth for a pending-create row under `parentDirAbs`. */
export function findPendingCreateInsertIndex(
  flat: readonly FlatNode[],
  parentDirAbs: string,
  workspaceRootAbs: string,
): { index: number; depth: number } {
  const parentNorm = normalizePathSlashes(parentDirAbs).replace(/\/$/, '');
  const rootNorm = normalizePathSlashes(workspaceRootAbs).replace(/\/$/, '');

  if (parentNorm === rootNorm) {
    return { index: flat.length, depth: 0 };
  }

  const parentIndex = flat.findIndex(
    (n) => normalizePathSlashes(n.path).replace(/\/$/, '') === parentNorm,
  );
  if (parentIndex < 0) {
    return { index: flat.length, depth: 0 };
  }

  const parentDepth = flat[parentIndex].depth;
  let insertAt = parentIndex + 1;
  while (insertAt < flat.length && flat[insertAt].depth > parentDepth) {
    insertAt++;
  }
  return { index: insertAt, depth: parentDepth + 1 };
}

export interface DirectoryEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export function fileNodesFromDirectoryEntries(entries: DirectoryEntry[], depth: number): FileNode[] {
  return entries.map((e) => ({
    name: e.name,
    path: e.path,
    isDirectory: e.isDirectory,
    expanded: false,
    children: e.isDirectory ? null : [],
    depth,
  }));
}

export function rebuildFlatTree(tree: FileNode[]): FlatNode[] {
  const result: FlatNode[] = [];
  const walk = (nodes: FileNode[]) => {
    for (const n of nodes) {
      result.push({
        name: n.name,
        path: n.path,
        isDirectory: n.isDirectory,
        expanded: n.expanded,
        depth: n.depth,
        hasChildren: n.isDirectory && (n.children === null || n.children.length > 0),
      });
      if (n.expanded && n.children) {
        walk(n.children);
      }
    }
  };
  walk(tree);
  return result;
}

export function findFileNode(nodes: FileNode[], targetPath: string): FileNode | null {
  for (const n of nodes) {
    if (n.path === targetPath) return n;
    if (n.children) {
      const found = findFileNode(n.children, targetPath);
      if (found) return found;
    }
  }
  return null;
}

export function findFileNodeByNormalizedPath(nodes: FileNode[], targetPath: string): FileNode | null {
  const norm = normalizeTreeAbsolutePath(targetPath);
  for (const n of nodes) {
    if (treePathsEqual(n.path, norm)) {
      return n;
    }
    if (n.children) {
      const found = findFileNodeByNormalizedPath(n.children, norm);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

export function collectExpandedPaths(nodes: FileNode[]): Set<string> {
  const expandedPaths = new Set<string>();
  const walk = (items: FileNode[]) => {
    for (const item of items) {
      if (item.isDirectory && item.expanded) {
        expandedPaths.add(item.path);
      }
      if (item.children && item.children.length > 0) {
        walk(item.children);
      }
    }
  };
  walk(nodes);
  return expandedPaths;
}

export function findParentPathInFlatTree(flat: FlatNode[], childPath: string): string | null {
  const childIndex = flat.findIndex((n) => n.path === childPath);
  if (childIndex <= 0) {
    return null;
  }

  const childDepth = flat[childIndex].depth;
  for (let i = childIndex - 1; i >= 0; i--) {
    if (flat[i].depth < childDepth && flat[i].isDirectory) {
      return flat[i].path;
    }
  }
  return null;
}

/** Normalize an absolute tree path for pending-operation lookups. */
export function normalizeTreeAbsolutePath(path: string): string {
  const normalized = normalizePathSlashes(path.trim());
  if (!normalized) {
    return normalized;
  }
  return normalized.replace(/\/$/, '') || normalized;
}

/** Compare absolute tree paths (slash-normalized; case-insensitive on Windows). */
export function treePathsEqual(a: string, b: string): boolean {
  const na = normalizeTreeAbsolutePath(a);
  const nb = normalizeTreeAbsolutePath(b);
  if (na === nb) {
    return true;
  }
  return na.toLowerCase() === nb.toLowerCase();
}

/** Join parent directory and entry name into a normalized absolute path. */
export function joinTreeAbsolutePath(parentDirAbs: string, entryName: string): string {
  const parent = normalizeTreeAbsolutePath(parentDirAbs);
  const name = entryName.trim();
  return parent ? `${parent}/${name}` : name;
}

/** Map workspace-files-changed payload paths to absolute paths on disk. */
export function absolutePathsFromWorkspaceChangeEvent(
  workspaceRootAbs: string,
  event: Pick<WorkspaceFilesChangedMessage, 'paths' | 'previousPaths'>,
): string[] {
  const root = normalizeTreeAbsolutePath(workspaceRootAbs);
  const out = new Set<string>();
  const addRel = (rel: string | undefined) => {
    const trimmed = (rel ?? '').trim();
    if (!trimmed || trimmed === '.') {
      return;
    }
    out.add(joinTreeAbsolutePath(root, normalizePathSlashes(trimmed)));
  };
  for (const rel of event.paths) {
    addRel(rel);
  }
  for (const rel of event.previousPaths ?? []) {
    addRel(rel);
  }
  return Array.from(out);
}

/** Basename for status-bar workspace change toasts. */
export function workspaceFileBasename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

export function scrollWorkspaceTreeNodeToPath(absolutePath: string): void {
  requestAnimationFrame(() => {
    const el = document.querySelector(`app-workspace .tree-node[data-path="${CSS.escape(absolutePath)}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });
}

export function scrollWorkspaceTreeNodeToSelected(selected: string): void {
  requestAnimationFrame(() => {
    const el = document.querySelector(`app-workspace .tree-node[data-path="${CSS.escape(selected)}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });
}

/** Parent directory portion of a workspace-relative path (`'.'` for root-level entries). */
export function parentWorkspaceRelativePath(relativePath: string): string {
  const norm = normalizePathSlashes(relativePath).replace(/^\.\/+/, '');
  if (!norm || norm === '.') {
    return '.';
  }
  const slash = norm.lastIndexOf('/');
  return slash >= 0 ? norm.slice(0, slash) : '.';
}

export function workspaceRelativePathFromAbsolute(
  workspaceRootAbs: string,
  absolutePath: string,
): string | null {
  const root = normalizeTreeAbsolutePath(workspaceRootAbs);
  const abs = normalizeTreeAbsolutePath(absolutePath);
  if (abs === root) {
    return '.';
  }
  const prefix = `${root}/`;
  if (!abs.startsWith(prefix)) {
    return null;
  }
  return abs.slice(prefix.length);
}

export function findFileNodeLocation(
  nodes: FileNode[],
  targetPath: string,
): { list: FileNode[]; index: number } | null {
  const norm = normalizeTreeAbsolutePath(targetPath);
  const walk = (list: FileNode[]): { list: FileNode[]; index: number } | null => {
    for (let i = 0; i < list.length; i++) {
      if (treePathsEqual(list[i].path, norm)) {
        return { list, index: i };
      }
      if (list[i].children) {
        const found = walk(list[i].children!);
        if (found) {
          return found;
        }
      }
    }
    return null;
  };
  return walk(nodes);
}

export function removeFileNodeAtPath(nodes: FileNode[], targetPath: string): boolean {
  const loc = findFileNodeLocation(nodes, targetPath);
  if (!loc) {
    return false;
  }
  loc.list.splice(loc.index, 1);
  return true;
}

/** Same-folder rename/move: rewrites paths in the affected subtree. */
export function renameFileNodeAtPath(
  nodes: FileNode[],
  oldPath: string,
  newPath: string,
  newName: string,
): boolean {
  const node = findFileNodeByNormalizedPath(nodes, oldPath);
  if (!node) {
    return false;
  }
  const oldNorm = normalizeTreeAbsolutePath(oldPath);
  const newNorm = normalizeTreeAbsolutePath(newPath);
  const rebase = (item: FileNode): void => {
    const itemNorm = normalizeTreeAbsolutePath(item.path);
    if (itemNorm === oldNorm || itemNorm.startsWith(`${oldNorm}/`)) {
      item.path = `${newNorm}${itemNorm.slice(oldNorm.length)}`;
    }
    if (item === node) {
      item.name = newName;
    }
    if (item.children) {
      for (const child of item.children) {
        rebase(child);
      }
    }
  };
  rebase(node);
  return true;
}

/** Refresh one folder listing while preserving expansion and loaded child subtrees. */
export function mergeDirectoryListingIntoChildren(
  existing: FileNode[] | null,
  entries: DirectoryEntry[],
  depth: number,
): FileNode[] {
  const fresh = fileNodesFromDirectoryEntries(entries, depth);
  if (!existing) {
    return fresh;
  }
  const expandedByPath = new Map(
    existing.map((child) => [normalizeTreeAbsolutePath(child.path), child.expanded]),
  );
  const oldByPath = new Map(existing.map((child) => [normalizeTreeAbsolutePath(child.path), child]));
  for (const child of fresh) {
    const key = normalizeTreeAbsolutePath(child.path);
    child.expanded = expandedByPath.get(key) ?? false;
    const old = oldByPath.get(key);
    if (old?.isDirectory && old.children !== null && child.isDirectory) {
      child.children = old.children;
    }
  }
  return fresh;
}

export interface WorkspaceFileChangeDescriptor {
  relativePath: string;
  kind: WorkspaceChangeKind;
  previousRelativePath?: string;
}

/** Strip staging paths and normalize workspace-relative change rows from IPC/watcher payloads. */
export function workspaceFileChangeDescriptorsFromEvent(
  event: Pick<WorkspaceFilesChangedMessage, 'paths' | 'kinds' | 'previousPaths'>,
): WorkspaceFileChangeDescriptor[] {
  const out: WorkspaceFileChangeDescriptor[] = [];
  for (let i = 0; i < event.paths.length; i++) {
    const raw = event.paths[i] ?? '';
    if (raw.startsWith('[staging]')) {
      continue;
    }
    const relativePath = normalizePathSlashes(raw.replace(/^\.\/+/, '')) || '.';
    out.push({
      relativePath,
      kind: event.kinds[i] ?? 'unknown',
      previousRelativePath: event.previousPaths?.[i]
        ? normalizePathSlashes(event.previousPaths[i]!.replace(/^\.\/+/, '')) || '.'
        : undefined,
    });
  }
  return out;
}

export function isWorkspaceTreeStructureChangeKind(kind: WorkspaceChangeKind): boolean {
  return kind === 'created' || kind === 'deleted' || kind === 'renamed' || kind === 'unknown';
}
