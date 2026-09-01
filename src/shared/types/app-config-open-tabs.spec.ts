import { describe, expect, it } from 'vitest';
import {
  normalizeWorkspaceOpenTabsByWorkspaceId,
  normalizeWorkspaceOpenTabsState,
  persistedWorkspaceOpenTabId,
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
