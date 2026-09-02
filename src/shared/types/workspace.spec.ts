import { describe, expect, it } from 'vitest';
import {
  NO_WORKSPACE_SYSTEM_PROMPT_ID,
  formatWorkspaceLastOpenedLabel,
  isFavoriteWorkspace,
  isNoWorkspaceSystemPromptId,
  reorderFavoriteWorkspaces,
  resolveSystemPromptStorageId,
  setWorkspaceFavorite,
  sortFavoriteWorkspaces,
  sortNonFavoriteWorkspaces,
  sortRecentWorkspaces,
  type Workspace,
} from './workspace';

describe('no-workspace system prompt id', () => {
  it('maps empty or null workspace ids to the reserved storage id', () => {
    expect(resolveSystemPromptStorageId(null)).toBe(NO_WORKSPACE_SYSTEM_PROMPT_ID);
    expect(resolveSystemPromptStorageId('')).toBe(NO_WORKSPACE_SYSTEM_PROMPT_ID);
    expect(resolveSystemPromptStorageId('   ')).toBe(NO_WORKSPACE_SYSTEM_PROMPT_ID);
  });

  it('keeps a real workspace id unchanged', () => {
    expect(resolveSystemPromptStorageId('ws-123')).toBe('ws-123');
  });

  it('treats empty and reserved ids as no-workspace', () => {
    expect(isNoWorkspaceSystemPromptId(null)).toBe(true);
    expect(isNoWorkspaceSystemPromptId('')).toBe(true);
    expect(isNoWorkspaceSystemPromptId(NO_WORKSPACE_SYSTEM_PROMPT_ID)).toBe(true);
    expect(isNoWorkspaceSystemPromptId('ws-123')).toBe(false);
  });
});

describe('sortRecentWorkspaces', () => {
  function ws(partial: Partial<Workspace> & Pick<Workspace, 'id' | 'name'>): Workspace {
    return {
      path: `/tmp/${partial.id}`,
      createdAt: '2026-01-01T00:00:00.000Z',
      ...partial,
    };
  }

  it('orders by lastOpenedAt then createdAt, newest first', () => {
    const older = ws({ id: 'a', name: 'A', lastOpenedAt: '2026-01-01T00:00:00.000Z' });
    const newer = ws({ id: 'b', name: 'B', lastOpenedAt: '2026-06-01T00:00:00.000Z' });
    expect(sortRecentWorkspaces([older, newer]).map((w) => w.id)).toEqual(['b', 'a']);
  });
});

describe('workspace favorites', () => {
  function ws(partial: Partial<Workspace> & Pick<Workspace, 'id' | 'name'>): Workspace {
    return {
      path: `/tmp/${partial.id}`,
      createdAt: '2026-01-01T00:00:00.000Z',
      ...partial,
    };
  }

  it('sorts favorites by favoriteOrder and leaves recents newest-first', () => {
    const recentNew = ws({ id: 'r1', name: 'New', lastOpenedAt: '2026-08-01T00:00:00.000Z' });
    const recentOld = ws({ id: 'r0', name: 'Old', lastOpenedAt: '2026-01-01T00:00:00.000Z' });
    const favSecond = ws({ id: 'f1', name: 'Second', favorite: true, favoriteOrder: 1 });
    const favFirst = ws({ id: 'f0', name: 'First', favorite: true, favoriteOrder: 0 });
    const all = [recentOld, favSecond, recentNew, favFirst];
    expect(sortFavoriteWorkspaces(all).map((w) => w.id)).toEqual(['f0', 'f1']);
    expect(sortNonFavoriteWorkspaces(all).map((w) => w.id)).toEqual(['r1', 'r0']);
  });

  it('appends a new favorite after existing ones and can unstar', () => {
    const a = ws({ id: 'a', name: 'A', favorite: true, favoriteOrder: 0 });
    const b = ws({ id: 'b', name: 'B' });
    const starred = setWorkspaceFavorite([a, b], 'b', true);
    expect(starred.find((w) => w.id === 'b')).toEqual(
      expect.objectContaining({ favorite: true, favoriteOrder: 1 }),
    );
    const unstarred = setWorkspaceFavorite(starred, 'a', false);
    expect(isFavoriteWorkspace(unstarred.find((w) => w.id === 'a')!)).toBe(false);
    expect(unstarred.find((w) => w.id === 'b')?.favoriteOrder).toBe(0);
  });

  it('reorders favorites and unstars omitted ids', () => {
    const a = ws({ id: 'a', name: 'A', favorite: true, favoriteOrder: 0 });
    const b = ws({ id: 'b', name: 'B', favorite: true, favoriteOrder: 1 });
    const c = ws({ id: 'c', name: 'C' });
    const next = reorderFavoriteWorkspaces([a, b, c], ['b', 'a']);
    expect(sortFavoriteWorkspaces(next).map((w) => w.id)).toEqual(['b', 'a']);
    const dropped = reorderFavoriteWorkspaces(next, ['b']);
    expect(dropped.find((w) => w.id === 'a')?.favorite).toBeUndefined();
    expect(dropped.find((w) => w.id === 'b')?.favoriteOrder).toBe(0);
  });
});

describe('formatWorkspaceLastOpenedLabel', () => {
  const now = Date.parse('2026-09-01T12:00:00.000Z');

  function ws(lastOpenedAt: string): Workspace {
    return {
      id: 'a',
      name: 'A',
      path: '/tmp/a',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastOpenedAt,
    };
  }

  it('uses relative labels for recent times', () => {
    expect(formatWorkspaceLastOpenedLabel(ws('2026-09-01T11:59:30.000Z'), now)).toBe('Just now');
    expect(formatWorkspaceLastOpenedLabel(ws('2026-09-01T11:40:00.000Z'), now)).toBe('20m ago');
    expect(formatWorkspaceLastOpenedLabel(ws('2026-09-01T09:00:00.000Z'), now)).toBe('3h ago');
    expect(formatWorkspaceLastOpenedLabel(ws('2026-08-31T12:00:00.000Z'), now)).toBe('Yesterday');
    expect(formatWorkspaceLastOpenedLabel(ws('2026-08-29T12:00:00.000Z'), now)).toBe('3d ago');
  });
});
