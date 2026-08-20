import { describe, expect, it } from 'vitest';
import { chatFileTabId, workspaceChatFileTab } from './app-chat-file-tabs';
import { planOpenWorkspaceImageTab } from './app-image-file-tabs';

describe('planOpenWorkspaceImageTab', () => {
  it('returns null for non-image paths', () => {
    expect(planOpenWorkspaceImageTab([], 'src/a.ts')).toBeNull();
    expect(planOpenWorkspaceImageTab([], '.project')).toBeNull();
  });

  it('opens a new tab when no same-folder image tab exists', () => {
    const tabs = [workspaceChatFileTab('src/a.ts'), workspaceChatFileTab('other/x.png')];
    expect(planOpenWorkspaceImageTab(tabs, 'photos/a.png')).toEqual({
      action: 'open',
      relativePath: 'photos/a.png',
    });
  });

  it('focuses an already-open exact image tab', () => {
    const tab = workspaceChatFileTab('photos/a.png');
    expect(planOpenWorkspaceImageTab([tab], 'photos/a.png')).toEqual({
      action: 'focus',
      tabId: chatFileTabId(tab),
    });
  });

  it('retargets an existing same-folder gallery tab', () => {
    const tabs = [workspaceChatFileTab('photos/a.png'), workspaceChatFileTab('src/a.ts')];
    expect(planOpenWorkspaceImageTab(tabs, 'photos/b.gif')).toEqual({
      action: 'retarget',
      oldRelativePath: 'photos/a.png',
      newRelativePath: 'photos/b.gif',
    });
  });

  it('prefers the active same-folder image tab when several exist', () => {
    const a = workspaceChatFileTab('photos/a.png');
    const c = workspaceChatFileTab('photos/c.png');
    const tabs = [a, c];
    expect(planOpenWorkspaceImageTab(tabs, 'photos/b.png', chatFileTabId(c))).toEqual({
      action: 'retarget',
      oldRelativePath: 'photos/c.png',
      newRelativePath: 'photos/b.png',
    });
  });

  it('does not reuse an image tab from a different folder', () => {
    const tabs = [workspaceChatFileTab('other/x.png')];
    expect(planOpenWorkspaceImageTab(tabs, 'photos/a.png')).toEqual({
      action: 'open',
      relativePath: 'photos/a.png',
    });
  });
});
