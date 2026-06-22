import { describe, expect, it } from 'vitest';

import {
  absolutePathsFromWorkspaceChangeEvent,
  findPendingCreateInsertIndex,
  isPendingCreateTreeNode,
  joinTreeAbsolutePath,
  normalizeTreeAbsolutePath,
  PENDING_CREATE_TREE_PATH,
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
