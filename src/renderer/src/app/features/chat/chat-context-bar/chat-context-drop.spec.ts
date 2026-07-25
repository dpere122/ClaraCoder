import { describe, expect, it } from 'vitest';
import { WORKSPACE_TREE_DRAG_MIME } from './chat-context-file';
import {
  canAcceptChatContextDrop,
  longestCommonDirectoryPrefix,
  resolveChatContextDropEffect,
} from './chat-context-drop';

function dragEvent(types: string[], extras: Partial<DataTransfer> = {}): DragEvent {
  return {
    dataTransfer: {
      types,
      files: extras.files ?? ([] as unknown as FileList),
      items: extras.items ?? ([] as unknown as DataTransferItemList),
      ...extras,
    },
  } as unknown as DragEvent;
}

describe('canAcceptChatContextDrop', () => {
  it('accepts workspace tree path drags', () => {
    expect(canAcceptChatContextDrop(dragEvent([WORKSPACE_TREE_DRAG_MIME, 'text/plain']))).toBe(true);
  });

  it('rejects plain text selection drags', () => {
    expect(canAcceptChatContextDrop(dragEvent(['text/plain']))).toBe(false);
    expect(canAcceptChatContextDrop(dragEvent(['text/plain', 'text/html']))).toBe(false);
  });

  it('accepts OS file drops when files are present', () => {
    const files = [{ path: '/tmp/a.ts' }] as unknown as FileList;
    Object.defineProperty(files, 'length', { value: 1 });
    expect(canAcceptChatContextDrop(dragEvent(['Files'], { files }))).toBe(true);
  });
});

describe('resolveChatContextDropEffect', () => {
  it('uses move for folder tree drags that declare move-only', () => {
    const dt = {
      types: ['application/x-nemo-workspace-internal-move'],
      effectAllowed: 'move',
    } as unknown as DataTransfer;
    expect(resolveChatContextDropEffect(dt)).toBe('move');
  });

  it('uses copy for file tree drags that allow copyMove', () => {
    const dt = {
      types: ['application/x-nemo-workspace-internal-move'],
      effectAllowed: 'copyMove',
    } as unknown as DataTransfer;
    expect(resolveChatContextDropEffect(dt)).toBe('copy');
  });

  it('uses copy for OS file drops', () => {
    const dt = {
      types: ['Files'],
      effectAllowed: 'copy',
    } as unknown as DataTransfer;
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
