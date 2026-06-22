import { describe, expect, it } from 'vitest';

import {
  absolutePathsFromWorkspaceChangeEvent,
  findPendingCreateInsertIndex,
  isPendingCreateTreeNode,
  joinTreeAbsolutePath,
  mergeDirectoryListingIntoChildren,
  normalizeTreeAbsolutePath,
  parentWorkspaceRelativePath,
  PENDING_CREATE_TREE_PATH,
  removeFileNodeAtPath,
  renameFileNodeAtPath,
  treePathsEqual,
  workspaceFileChangeDescriptorsFromEvent,
  type FileNode,
  type FlatNode,
} from './workspace-tree';

describe('workspace-tree pending create', () => {
  const root = 'C:/project';

  it('detects the pending-create sentinel node', () => {
    const node: FlatNode = {
      name: '',
      path: PENDING_CREATE_TREE_PATH,
      isDirectory: false,
      expanded: false,
      depth: 1,
      hasChildren: false,
    };
    expect(isPendingCreateTreeNode(node)).toBe(true);
  });

  it('inserts at root level after existing entries', () => {
    const flat: FlatNode[] = [
      { name: 'a.ts', path: `${root}/a.ts`, isDirectory: false, expanded: false, depth: 0, hasChildren: false },
      {
        name: 'src',
        path: `${root}/src`,
        isDirectory: true,
        expanded: true,
        depth: 0,
        hasChildren: true,
      },
      {
        name: 'main.ts',
        path: `${root}/src/main.ts`,
        isDirectory: false,
        expanded: false,
        depth: 1,
        hasChildren: false,
      },
    ];
    expect(findPendingCreateInsertIndex(flat, root, root)).toEqual({ index: 3, depth: 0 });
  });

  it('inserts inside an expanded folder after its children', () => {
    const flat: FlatNode[] = [
      {
        name: 'src',
        path: `${root}/src`,
        isDirectory: true,
        expanded: true,
        depth: 0,
        hasChildren: true,
      },
      {
        name: 'main.ts',
        path: `${root}/src/main.ts`,
        isDirectory: false,
        expanded: false,
        depth: 1,
        hasChildren: false,
      },
      { name: 'b.ts', path: `${root}/b.ts`, isDirectory: false, expanded: false, depth: 0, hasChildren: false },
    ];
    expect(findPendingCreateInsertIndex(flat, `${root}/src`, root)).toEqual({ index: 2, depth: 1 });
  });
});

describe('workspace-tree disk op paths', () => {
  const root = 'C:/project';

  it('normalizes absolute tree paths', () => {
    expect(normalizeTreeAbsolutePath('C:/project/src/')).toBe('C:/project/src');
    expect(normalizeTreeAbsolutePath('C:\\project\\src')).toBe('C:/project/src');
  });

  it('compares tree paths case-insensitively', () => {
    expect(treePathsEqual('C:/Users/project/src', 'c:/users/project/src')).toBe(true);
    expect(treePathsEqual('C:/Users/project/src', 'C:/Users/project/lib')).toBe(false);
  });

  it('joins parent dir and entry name', () => {
    expect(joinTreeAbsolutePath(`${root}/src`, 'main.ts')).toBe(`${root}/src/main.ts`);
  });

  it('maps workspace change events to absolute paths', () => {
    expect(
      absolutePathsFromWorkspaceChangeEvent(root, {
        paths: ['src/main.ts'],
        previousPaths: ['src/old.ts'],
      }),
    ).toEqual([`${root}/src/main.ts`, `${root}/src/old.ts`]);
  });
});

describe('workspace-tree incremental mutations', () => {
  const root = 'C:/project';

  it('removes a file node without touching siblings', () => {
    const tree: FileNode[] = [
      { name: 'a.ts', path: `${root}/a.ts`, isDirectory: false, expanded: false, children: [], depth: 0 },
      { name: 'b.ts', path: `${root}/b.ts`, isDirectory: false, expanded: false, children: [], depth: 0 },
    ];
    expect(removeFileNodeAtPath(tree, `${root}/a.ts`)).toBe(true);
    expect(tree.map((n) => n.name)).toEqual(['b.ts']);
  });

  it('renames a file in place', () => {
    const tree: FileNode[] = [
      { name: 'old.ts', path: `${root}/old.ts`, isDirectory: false, expanded: false, children: [], depth: 0 },
    ];
    expect(renameFileNodeAtPath(tree, `${root}/old.ts`, `${root}/new.ts`, 'new.ts')).toBe(true);
    expect(tree[0]).toMatchObject({ name: 'new.ts', path: `${root}/new.ts` });
  });

  it('renames a file when paths use mixed slashes', () => {
    const tree: FileNode[] = [
      {
        name: 'old.ts',
        path: `${root}\\src\\old.ts`,
        isDirectory: false,
        expanded: false,
        children: [],
        depth: 1,
      },
    ];
    expect(renameFileNodeAtPath(tree, `${root}/src/old.ts`, `${root}/src/new.ts`, 'new.ts')).toBe(true);
    expect(tree[0]).toMatchObject({ name: 'new.ts', path: `${root}/src/new.ts` });
  });

  it('rebases paths for renamed folders', () => {
    const tree: FileNode[] = [
      {
        name: 'src',
        path: `${root}/src`,
        isDirectory: true,
        expanded: true,
        depth: 0,
        children: [
          {
            name: 'main.ts',
            path: `${root}/src/main.ts`,
            isDirectory: false,
            expanded: false,
            children: [],
            depth: 1,
          },
        ],
      },
    ];
    expect(renameFileNodeAtPath(tree, `${root}/src`, `${root}/lib`, 'lib')).toBe(true);
    expect(tree[0]?.path).toBe(`${root}/lib`);
    expect(tree[0]?.children?.[0]?.path).toBe(`${root}/lib/main.ts`);
  });

  it('preserves expanded subtrees when merging directory listings', () => {
    const existing: FileNode[] = [
      {
        name: 'src',
        path: `${root}/src`,
        isDirectory: true,
        expanded: true,
        depth: 0,
        children: [
          {
            name: 'main.ts',
            path: `${root}/src/main.ts`,
            isDirectory: false,
            expanded: false,
            children: [],
            depth: 1,
          },
        ],
      },
    ];
    const merged = mergeDirectoryListingIntoChildren(
      existing,
      [
        { name: 'src', path: `${root}/src`, isDirectory: true },
        { name: 'new.ts', path: `${root}/new.ts`, isDirectory: false },
      ],
      0,
    );
    expect(merged.map((n) => n.name)).toEqual(['src', 'new.ts']);
    expect(merged[0]?.expanded).toBe(true);
    expect(merged[0]?.children?.[0]?.path).toBe(`${root}/src/main.ts`);
  });

  it('ignores staging paths in change descriptors', () => {
    expect(
      workspaceFileChangeDescriptorsFromEvent({
        paths: ['[staging] draft.ts', 'src/a.ts'],
        kinds: ['created', 'deleted'],
      }),
    ).toEqual([{ relativePath: 'src/a.ts', kind: 'deleted', previousRelativePath: undefined }]);
  });

  it('derives parent relative paths', () => {
    expect(parentWorkspaceRelativePath('src/main.ts')).toBe('src');
    expect(parentWorkspaceRelativePath('main.ts')).toBe('.');
  });
});
