import { describe, it, expect, vi } from 'vitest';

const { mainState, send } = vi.hoisted(() => {
  const send = vi.fn();
  return { send, mainState: { mainWindow: { isDestroyed: () => false, webContents: { send } } } };
});

vi.mock('./state', () => ({ mainState }));

import {
  getMainWindowView,
  isBrowserBridgeEvent,
  noteMainWindowConversationsChanged,
  noteMainWindowView,
  parseMainWindowComposer,
} from './main-window-view';

describe('main window view', () => {
  const appWindow = { sender: {} };
  const bridgeTab = { sender: {}, fromBrowserBridge: true };

  it('follows the real window, ignores bridge tabs acting as it, and pushes each change', () => {
    noteMainWindowView(appWindow, { workspaceId: 'ws-java', conversationId: 'conv-java' });
    noteMainWindowView(bridgeTab, { workspaceId: 'ws-clara', conversationId: 'conv-clara' });

    expect(isBrowserBridgeEvent(bridgeTab)).toBe(true);
    expect(isBrowserBridgeEvent(appWindow)).toBe(false);
    expect(getMainWindowView()).toEqual({ workspaceId: 'ws-java', conversationId: 'conv-java', conversationsRevision: 0, composer: null });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('main-window-view-changed', {
      workspaceId: 'ws-java',
      conversationId: 'conv-java',
      conversationsRevision: 0,
      composer: null,
    });

    // Same view again: no push.
    noteMainWindowView(appWindow, { conversationId: 'conv-java' });
    expect(send).toHaveBeenCalledTimes(1);

    // Switching workspace clears the conversation until the window loads one.
    noteMainWindowView(appWindow, { workspaceId: 'ws-other', conversationId: null });
    expect(getMainWindowView()).toMatchObject({ workspaceId: 'ws-other', conversationId: null });
  });

  it('bumps the list revision when the window changes a conversation, not when a bridge tab does', () => {
    const before = getMainWindowView().conversationsRevision;
    send.mockClear();

    noteMainWindowConversationsChanged(appWindow);
    noteMainWindowConversationsChanged(bridgeTab);

    expect(getMainWindowView().conversationsRevision).toBe(before + 1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps the window's composer (mode, Auto Run, Admin) and ignores a bridge tab's", () => {
    const composer = parseMainWindowComposer({ mode: 'plan', autoApply: true, admin: false });
    expect(composer).toEqual({ mode: 'plan', autoApply: true, admin: false });

    noteMainWindowView(appWindow, { composer: composer! });
    noteMainWindowView(bridgeTab, { composer: { mode: 'ask', autoApply: false, admin: true } });

    expect(getMainWindowView().composer).toEqual({ mode: 'plan', autoApply: true, admin: false });
  });

  it('rejects a malformed composer report', () => {
    expect(parseMainWindowComposer({ mode: 'yolo', autoApply: true, admin: true })).toBeNull();
    expect(parseMainWindowComposer(null)).toBeNull();
    expect(parseMainWindowComposer({ mode: 'ask', autoApply: 'yes', admin: 1 })).toEqual({
      mode: 'ask',
      autoApply: false,
      admin: false,
    });
  });
});
