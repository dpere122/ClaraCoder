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

export function findFileNodeByNormalizedPath(nodes: FileNode[], normalizedPath: string): FileNode | null {
  for (const n of nodes) {
    if (normalizePathSlashes(n.path) === normalizedPath) {
      return n;
    }
    if (n.children) {
      const found = findFileNodeByNormalizedPath(n.children, normalizedPath);
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
