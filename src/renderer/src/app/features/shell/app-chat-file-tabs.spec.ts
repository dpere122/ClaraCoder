import { describe, expect, it } from 'vitest';

import {
  chatFileTabBasename,
  chatFileTabId,
  chatFileTabModelKey,
  openTabForRenamedFile,
  replaceFileTabAfterSaveAs,
  retargetFileTabPath,
  workspaceChatFileTab,
} from './app-chat-file-tabs';

describe('app-chat-file-tabs', () => {
  it('builds stable ids for workspace and external tabs', () => {
    const ws = workspaceChatFileTab('src/foo.ts');
    expect(chatFileTabId(ws)).toBe('file:rel:src/foo.ts');
    expect(chatFileTabModelKey(ws)).toBe('rel:src/foo.ts');

    const ext = { absolutePath: 'C:/tmp/out.ts', outsideWorkspace: true };
    expect(chatFileTabId(ext)).toBe('file:abs:C:/tmp/out.ts');
    expect(chatFileTabBasename(ext)).toBe('out.ts');
  });

  it('retargets workspace tabs on rename', () => {
    const tabs = [workspaceChatFileTab('a/old.ts'), workspaceChatFileTab('b/other.ts')];
    const next = retargetFileTabPath(tabs, 'a/old.ts', 'a/new.ts');
    expect(next[0]?.relativePath).toBe('a/new.ts');
    expect(next[1]?.relativePath).toBe('b/other.ts');
  });

  it('keeps the old tab and opens a tab for the renamed path', () => {
    const tabs = [workspaceChatFileTab('a/old.ts'), workspaceChatFileTab('b/other.ts')];
    const { tabs: next, focusTabId } = openTabForRenamedFile(tabs, 'a/old.ts', 'a/new.ts');
    expect(next).toHaveLength(3);
    expect(next[0]?.relativePath).toBe('a/old.ts');
    expect(next[1]?.relativePath).toBe('b/other.ts');
    expect(next[2]?.relativePath).toBe('a/new.ts');
    expect(focusTabId).toBe('file:rel:a/new.ts');
  });

  it('does not open a renamed tab when the old path was not open', () => {
    const tabs = [workspaceChatFileTab('b/other.ts')];
    const { tabs: next, focusTabId } = openTabForRenamedFile(tabs, 'a/old.ts', 'a/new.ts');
    expect(next).toHaveLength(1);
    expect(focusTabId).toBeNull();
  });

  it('replaces tab after Save As to external path', () => {
    const tabs = [workspaceChatFileTab('gone.ts')];
    const oldKey = chatFileTabModelKey(tabs[0]!);
    const next = replaceFileTabAfterSaveAs(tabs, oldKey, {
      absolutePath: 'D:/backup/gone.ts',
      outsideWorkspace: true,
    });
    expect(next[0]?.outsideWorkspace).toBe(true);
    expect(next[0]?.absolutePath).toBe('D:/backup/gone.ts');
    expect(next[0]?.relativePath).toBeUndefined();
  });

  it('replaces tab after Save As into workspace', () => {
    const tabs = [workspaceChatFileTab('old.ts')];
    const oldKey = chatFileTabModelKey(tabs[0]!);
    const next = replaceFileTabAfterSaveAs(tabs, oldKey, {
      relativePath: 'renamed.ts',
      outsideWorkspace: false,
    });
    expect(next[0]?.relativePath).toBe('renamed.ts');
    expect(next[0]?.outsideWorkspace).toBeFalsy();
  });
});
