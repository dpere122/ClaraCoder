import { describe, expect, it } from 'vitest';

import {
  allFileTabIds,
  buildPlanChatFileTab,
  chatFileTabBasename,
  chatFileTabId,
  chatFileTabModelKey,
  deactivateBuildPlanTab,
  fileTabIdsToLeft,
  fileTabIdsToRight,
  findBuildPlanTab,
  openTabForRenamedFile,
  removeBuildPlanTab,
  replaceFileTabAfterSaveAs,
  reorderFileTabs,
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

  it('builds build-plan tabs with preview-only metadata', () => {
    const tab = buildPlanChatFileTab('.nemo/build-plans/p1.md', 'p1', true);
    expect(tab.previewOnly).toBe(true);
    expect(tab.buildPlanId).toBe('p1');
    expect(tab.buildPlanActive).toBe(true);
    expect(chatFileTabId(tab)).toBe('file:rel:.nemo/build-plans/p1.md');
  });

  it('lists tab ids to the left and right of an anchor tab', () => {
    const tabs = [
      workspaceChatFileTab('a.ts'),
      workspaceChatFileTab('b.ts'),
      workspaceChatFileTab('c.ts'),
    ];
    const anchor = chatFileTabId(tabs[1]!);
    expect(fileTabIdsToLeft(tabs, anchor)).toEqual(['file:rel:a.ts']);
    expect(fileTabIdsToRight(tabs, anchor)).toEqual(['file:rel:c.ts']);
    expect(allFileTabIds(tabs)).toEqual([
      'file:rel:a.ts',
      'file:rel:b.ts',
      'file:rel:c.ts',
    ]);
    expect(fileTabIdsToLeft(tabs, chatFileTabId(tabs[0]!))).toEqual([]);
    expect(fileTabIdsToRight(tabs, chatFileTabId(tabs[2]!))).toEqual([]);
  });

  it('reorders tabs by moving one index to another', () => {
    const tabs = [
      workspaceChatFileTab('a.ts'),
      workspaceChatFileTab('b.ts'),
      workspaceChatFileTab('c.ts'),
    ];
    expect(reorderFileTabs(tabs, 0, 2).map((t) => t.relativePath)).toEqual(['b.ts', 'c.ts', 'a.ts']);
    expect(reorderFileTabs(tabs, 2, 0).map((t) => t.relativePath)).toEqual(['c.ts', 'a.ts', 'b.ts']);
    expect(reorderFileTabs(tabs, 1, 1)).toEqual(tabs);
    expect(reorderFileTabs(tabs, -1, 1)).toEqual(tabs);
  });

  it('deactivates and removes build-plan tabs by plan id', () => {
    const tabs = [
      buildPlanChatFileTab('.nemo/build-plans/p1.md', 'p1', true),
      workspaceChatFileTab('src/foo.ts'),
    ];
    expect(findBuildPlanTab(tabs, 'p1')?.buildPlanActive).toBe(true);
    const inactive = deactivateBuildPlanTab(tabs, 'p1');
    expect(findBuildPlanTab(inactive, 'p1')?.buildPlanActive).toBe(false);
    const remaining = removeBuildPlanTab(inactive, 'p1');
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.relativePath).toBe('src/foo.ts');
  });
});
