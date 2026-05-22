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

export function describeWorkspaceChange(event: { paths: string[]; kinds: WorkspaceChangeKind[] }): string {
  const kind = event.kinds[0] ?? 'unknown';
  const pathLabel = event.paths[0] ?? 'workspace';
  const moreCount = Math.max(0, event.paths.length - 1);
  const kindLabel = kind === 'unknown' ? 'changed' : kind;
  if (moreCount === 0) {
    return `${pathLabel} ${kindLabel}`;
  }
  return `${pathLabel} ${kindLabel} (+${moreCount} more)`;
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
