import { describe, expect, it } from 'vitest';
import { longestCommonDirectoryPrefix, resolveChatContextDropEffect } from './chat-context-drop';

describe('resolveChatContextDropEffect', () => {
  it('uses move for folder tree drags that declare move-only', () => {
    const dt = {
      types: ['application/x-nemo-workspace-internal-move'],
      effectAllowed: 'move',
    } as DataTransfer;
    expect(resolveChatContextDropEffect(dt)).toBe('move');
  });

  it('uses copy for file tree drags that allow copyMove', () => {
    const dt = {
      types: ['application/x-nemo-workspace-internal-move'],
      effectAllowed: 'copyMove',
    } as DataTransfer;
    expect(resolveChatContextDropEffect(dt)).toBe('copy');
  });

  it('uses copy for OS file drops', () => {
    const dt = {
      types: ['Files'],
      effectAllowed: 'copy',
    } as DataTransfer;
    expect(resolveChatContextDropEffect(dt)).toBe('copy');
  });
});

describe('longestCommonDirectoryPrefix', () => {
  it('returns the shared folder root for nested files from one folder drop', () => {
    expect(
      longestCommonDirectoryPrefix([
        'C:/ws/src/components/a.ts',
        'C:/ws/src/components/b.ts',
        'C:/ws/src/components/nested/c.ts',
      ]),
    ).toBe('C:/ws/src/components');
  });

  it('normalizes Windows-style paths', () => {
    expect(
      longestCommonDirectoryPrefix([
        'C:\\ws\\src\\components\\a.ts',
        'C:\\ws\\src\\components\\b.ts',
      ]),
    ).toBe('C:/ws/src/components');
  });
});
