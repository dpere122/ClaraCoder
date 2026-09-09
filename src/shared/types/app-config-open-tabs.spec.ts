import { describe, expect, it } from 'vitest';
import {
  normalizeWorkspaceOpenTabsByWorkspaceId,
  normalizeWorkspaceOpenTabsState,
  persistedWorkspaceOpenTabId,
  pruneRemovedWorkspaceClientState,
  retainRendererWorkspaceOpenTabs,
} from './app-config';

describe('persistedWorkspaceOpenTabId', () => {
  it('builds file:rel and file:abs ids', () => {
    expect(persistedWorkspaceOpenTabId({ relativePath: 'src/foo.ts', outsideWorkspace: false })).toBe(
      'file:rel:src/foo.ts',
    );
    expect(
      persistedWorkspaceOpenTabId({ absolutePath: 'C:\\tmp\\out.ts', outsideWorkspace: true }),
    ).toBe('file:abs:C:/tmp/out.ts');
  });
});

describe('normalizeWorkspaceOpenTabsState', () => {
  it('keeps valid workspace and external tabs and the active id', () => {
    const { state, migrated } = normalizeWorkspaceOpenTabsState({
      tabs: [
        { relativePath: 'src\\foo.ts', outsideWorkspace: false },
        { absolutePath: 'D:/ext.ts', outsideWorkspace: true },
      ],
      activeTabId: 'file:rel:src/foo.ts',
    });
    expect(migrated).toBe(true);
    expect(state).toEqual({
      tabs: [
        { relativePath: 'src/foo.ts', outsideWorkspace: false },
        { absolutePath: 'D:/ext.ts', outsideWorkspace: true },
      ],
      activeTabId: 'file:rel:src/foo.ts',
    });
  });

  it('drops build-plan-like junk, duplicates, and unknown active ids', () => {
    const { state, migrated } = normalizeWorkspaceOpenTabsState({
      tabs: [
        { relativePath: 'a.ts' },
        { relativePath: 'a.ts' },
        { outsideWorkspace: true },
        null,
        { relativePath: 'b.ts' },
      ],
      activeTabId: 'file:rel:missing.ts',
    });
    expect(migrated).toBe(true);
    expect(state?.tabs.map((t) => t.relativePath)).toEqual(['a.ts', 'b.ts']);
    expect(state?.activeTabId).toBeNull();
  });

  it('treats an empty tab list as absent state', () => {
    const { state, migrated } = normalizeWorkspaceOpenTabsState({
      tabs: [],
      activeTabId: null,
    });
    expect(state).toBeNull();
    expect(migrated).toBe(false);
  });

  it('keeps a valid grid layout and normalizes its sizes', () => {
    const { state, migrated } = normalizeWorkspaceOpenTabsState({
      tabs: [{ relativePath: 'a.ts', outsideWorkspace: false }, { relativePath: 'b.ts', outsideWorkspace: false }],
      activeTabId: 'file:rel:b.ts',
      layout: {
        columns: [
          { slots: [{ tabIds: ['file:rel:a.ts'], activeTabId: 'file:rel:a.ts' }], rowSizes: [1] },
          {
            slots: [
              { tabIds: ['file:rel:b.ts', 'file:rel:a.ts'], activeTabId: 'file:rel:b.ts' },
              { tabIds: ['file:rel:a.ts'], activeTabId: null },
            ],
            rowSizes: [3, 1],
          },
        ],
        columnSizes: [1, 3],
        focused: [1, 0],
      },
    });
    expect(migrated).toBe(false);
    expect(state?.layout?.columnSizes).toEqual([0.25, 0.75]);
    expect(state?.layout?.columns[1]?.rowSizes).toEqual([0.75, 0.25]);
    expect(state?.layout?.columns[1]?.slots[1]?.activeTabId).toBe('file:rel:a.ts');
    expect(state?.layout?.focused).toEqual([1, 0]);
  });

  it('drops the layout (and migrates) when it references unknown tabs', () => {
    const { state, migrated } = normalizeWorkspaceOpenTabsState({
      tabs: [{ relativePath: 'a.ts', outsideWorkspace: false }],
      activeTabId: 'file:rel:a.ts',
      layout: {
        columns: [{ slots: [{ tabIds: ['file:rel:missing.ts'], activeTabId: null }], rowSizes: [1] }],
        columnSizes: [1],
      },
    });
    expect(migrated).toBe(true);
    expect(state?.tabs).toHaveLength(1);
    expect(state?.layout).toBeUndefined();
  });

  it('drops layouts that exceed the 3x3 cap or contain empty slots', () => {
    const slot = { tabIds: ['file:rel:a.ts'], activeTabId: null };
    const tooManyColumns = normalizeWorkspaceOpenTabsState({
      tabs: [{ relativePath: 'a.ts', outsideWorkspace: false }],
      activeTabId: null,
      layout: {
        columns: [1, 2, 3, 4].map(() => ({ slots: [slot], rowSizes: [1] })),
        columnSizes: [1, 1, 1, 1],
      },
    });
    expect(tooManyColumns.migrated).toBe(true);
    expect(tooManyColumns.state?.layout).toBeUndefined();

    const tooManyRows = normalizeWorkspaceOpenTabsState({
      tabs: [{ relativePath: 'a.ts', outsideWorkspace: false }],
      activeTabId: null,
      layout: {
        columns: [{ slots: [slot, slot, slot, slot], rowSizes: [1, 1, 1, 1] }],
        columnSizes: [1],
      },
    });
    expect(tooManyRows.state?.layout).toBeUndefined();

    const emptySlot = normalizeWorkspaceOpenTabsState({
      tabs: [{ relativePath: 'a.ts', outsideWorkspace: false }],
      activeTabId: null,
      layout: {
        columns: [{ slots: [{ tabIds: [], activeTabId: null }], rowSizes: [1] }],
        columnSizes: [1],
      },
    });
    expect(emptySlot.state?.layout).toBeUndefined();
  });

  it('uses even sizes and ignores an out-of-range focus when sizes are malformed', () => {
    const { state, migrated } = normalizeWorkspaceOpenTabsState({
      tabs: [{ relativePath: 'a.ts', outsideWorkspace: false }, { relativePath: 'b.ts', outsideWorkspace: false }],
      activeTabId: null,
      layout: {
        columns: [
          { slots: [{ tabIds: ['file:rel:a.ts'], activeTabId: null }], rowSizes: 'nope' },
          { slots: [{ tabIds: ['file:rel:b.ts'], activeTabId: null }], rowSizes: [-1] },
        ],
        columnSizes: [1],
        focused: [5, 0],
      },
    });
    expect(migrated).toBe(false);
    expect(state?.layout?.columnSizes).toEqual([0.5, 0.5]);
    expect(state?.layout?.columns.map((c) => c.rowSizes)).toEqual([[1], [1]]);
    expect(state?.layout?.focused).toBeUndefined();
  });
});

describe('normalizeWorkspaceOpenTabsByWorkspaceId', () => {
  it('drops empty workspace ids and invalid entries', () => {
    const { openTabsByWorkspaceId, migrated } = normalizeWorkspaceOpenTabsByWorkspaceId({
      'ws-a': {
        tabs: [{ relativePath: 'src/a.ts' }],
        activeTabId: 'file:rel:src/a.ts',
      },
      '': {
        tabs: [{ relativePath: 'nope.ts' }],
        activeTabId: 'file:rel:nope.ts',
      },
      'ws-bad': { tabs: 'nope' },
    });
    expect(migrated).toBe(true);
    expect(openTabsByWorkspaceId).toEqual({
      'ws-a': {
        tabs: [{ relativePath: 'src/a.ts', outsideWorkspace: false }],
        activeTabId: 'file:rel:src/a.ts',
      },
    });
  });

  it('returns empty without migrating when the field is missing', () => {
    const { openTabsByWorkspaceId, migrated } = normalizeWorkspaceOpenTabsByWorkspaceId(undefined);
    expect(openTabsByWorkspaceId).toEqual({});
    expect(migrated).toBe(false);
  });
});

describe('retainRendererWorkspaceOpenTabs', () => {
  it('keeps renderer tabs when the incoming broadcast has a stale map', () => {
    const incoming = {
      workspaces: [
        { id: 'ws-a', name: 'A', path: '/a', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'ws-b', name: 'B', path: '/b', createdAt: '2026-01-01T00:00:00.000Z' },
      ],
      workspaceOpenTabsByWorkspaceId: {},
    };
    const retained = retainRendererWorkspaceOpenTabs(incoming as never, {
      'ws-a': {
        tabs: [{ relativePath: 'src/foo.ts', outsideWorkspace: false }],
        activeTabId: 'file:rel:src/foo.ts',
      },
    });
    expect(retained.workspaceOpenTabsByWorkspaceId).toEqual({
      'ws-a': {
        tabs: [{ relativePath: 'src/foo.ts', outsideWorkspace: false }],
        activeTabId: 'file:rel:src/foo.ts',
      },
    });
  });

  it('drops renderer tabs for workspaces no longer in the incoming registry', () => {
    const incoming = {
      workspaces: [{ id: 'ws-b', name: 'B', path: '/b', createdAt: '2026-01-01T00:00:00.000Z' }],
      workspaceOpenTabsByWorkspaceId: {},
    };
    const retained = retainRendererWorkspaceOpenTabs(incoming as never, {
      'ws-a': {
        tabs: [{ relativePath: 'gone.ts', outsideWorkspace: false }],
        activeTabId: 'file:rel:gone.ts',
      },
      'ws-b': {
        tabs: [{ relativePath: 'keep.ts', outsideWorkspace: false }],
        activeTabId: 'file:rel:keep.ts',
      },
    });
    expect(retained.workspaceOpenTabsByWorkspaceId).toEqual({
      'ws-b': {
        tabs: [{ relativePath: 'keep.ts', outsideWorkspace: false }],
        activeTabId: 'file:rel:keep.ts',
      },
    });
  });
});

describe('pruneRemovedWorkspaceClientState', () => {
  it('removes open-tab, monaco-scroll, and last-active conversation entries for the workspace', () => {
    const config = {
      workspaces: [{ id: 'ws-a', name: 'A', path: '/a', createdAt: '2026-01-01T00:00:00.000Z' }],
      workspaceOpenTabsByWorkspaceId: {
        'ws-a': {
          tabs: [{ relativePath: 'a.ts', outsideWorkspace: false }],
          activeTabId: 'file:rel:a.ts',
        },
        'ws-b': {
          tabs: [{ relativePath: 'b.ts', outsideWorkspace: false }],
          activeTabId: 'file:rel:b.ts',
        },
      },
      workspaceMonacoScrollByWorkspaceId: {
        'ws-a': { 'a.ts': { scrollTop: 1, scrollLeft: 0 } },
        'ws-b': { 'b.ts': { scrollTop: 2, scrollLeft: 0 } },
      },
      lastActiveConversationByWorkspaceId: {
        'ws-a': 'conv-a',
        'ws-b': 'conv-b',
      },
    };
    pruneRemovedWorkspaceClientState(config as never, 'ws-a');
    expect(config.workspaceOpenTabsByWorkspaceId).toEqual({
      'ws-b': {
        tabs: [{ relativePath: 'b.ts', outsideWorkspace: false }],
        activeTabId: 'file:rel:b.ts',
      },
    });
    expect(config.workspaceMonacoScrollByWorkspaceId).toEqual({
      'ws-b': { 'b.ts': { scrollTop: 2, scrollLeft: 0 } },
    });
    expect(config.lastActiveConversationByWorkspaceId).toEqual({
      'ws-b': 'conv-b',
    });
  });
});
