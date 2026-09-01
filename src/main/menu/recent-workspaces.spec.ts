import { describe, expect, it } from 'vitest';
import type { Workspace } from '../../shared';
import { sortRecentWorkspaces } from '../../shared';

function ws(partial: Partial<Workspace> & Pick<Workspace, 'id' | 'name'>): Workspace {
  return {
    path: `/tmp/${partial.id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('sortRecentWorkspaces', () => {
  it('orders by lastOpenedAt descending', () => {
    const older = ws({ id: 'a', name: 'A', lastOpenedAt: '2026-01-01T00:00:00.000Z' });
    const newer = ws({ id: 'b', name: 'B', lastOpenedAt: '2026-06-01T00:00:00.000Z' });
    expect(sortRecentWorkspaces([older, newer]).map((w) => w.id)).toEqual(['b', 'a']);
  });

  it('falls back to createdAt when lastOpenedAt is missing', () => {
    const older = ws({ id: 'a', name: 'A', createdAt: '2025-01-01T00:00:00.000Z' });
    const newer = ws({ id: 'b', name: 'B', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(sortRecentWorkspaces([older, newer]).map((w) => w.id)).toEqual(['b', 'a']);
  });

  it('prefers lastOpenedAt over createdAt', () => {
    const recentlyOpened = ws({
      id: 'old-created',
      name: 'Old',
      createdAt: '2020-01-01T00:00:00.000Z',
      lastOpenedAt: '2026-08-01T00:00:00.000Z',
    });
    const newlyCreated = ws({
      id: 'new-created',
      name: 'New',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    expect(sortRecentWorkspaces([newlyCreated, recentlyOpened]).map((w) => w.id)).toEqual([
      'old-created',
      'new-created',
    ]);
  });

  it('breaks remaining ties by name', () => {
    const stamp = '2026-01-01T00:00:00.000Z';
    const zebra = ws({ id: 'z', name: 'Zebra', lastOpenedAt: stamp });
    const alpha = ws({ id: 'a', name: 'Alpha', lastOpenedAt: stamp });
    expect(sortRecentWorkspaces([zebra, alpha]).map((w) => w.name)).toEqual(['Alpha', 'Zebra']);
  });

  it('does not mutate the input array', () => {
    const first = ws({ id: 'a', name: 'A', lastOpenedAt: '2026-01-01T00:00:00.000Z' });
    const second = ws({ id: 'b', name: 'B', lastOpenedAt: '2026-06-01T00:00:00.000Z' });
    const input = [first, second];
    sortRecentWorkspaces(input);
    expect(input.map((w) => w.id)).toEqual(['a', 'b']);
  });
});
