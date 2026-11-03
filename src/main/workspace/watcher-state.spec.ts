import { describe, expect, it } from 'vitest';
import { batchedChangeKind } from './watcher-state';

describe('batchedChangeKind', () => {
  it('keeps a file written right after it was created as new', () => {
    expect(batchedChangeKind('created', 'updated')).toBe('created');
  });

  it.each([
    [undefined, 'updated', 'updated'],
    ['updated', 'created', 'created'],
    ['created', 'deleted', 'deleted'],
    ['deleted', 'created', 'created'],
    ['updated', 'deleted', 'deleted'],
    ['deleted', 'updated', 'updated'],
  ] as const)('after %s, %s is %s', (previous, next, kind) => {
    expect(batchedChangeKind(previous, next)).toBe(kind);
  });
});
