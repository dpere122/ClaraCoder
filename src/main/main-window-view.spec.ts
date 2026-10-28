import { describe, it, expect, vi } from 'vitest';

const { mainState, send } = vi.hoisted(() => {
  const send = vi.fn();
  return { send, mainState: { mainWindow: { isDestroyed: () => false, webContents: { send } } } };
});

vi.mock('./state', () => ({ mainState }));

import { getMainWindowView, isBrowserBridgeEvent, noteMainWindowView } from './main-window-view';

describe('main window view', () => {
  it('follows the real window, ignores bridge tabs acting as it, and pushes each change', () => {
    const appWindow = { sender: {} };
    const bridgeTab = { sender: {}, fromBrowserBridge: true };

    noteMainWindowView(appWindow, { workspaceId: 'ws-java', conversationId: 'conv-java' });
    noteMainWindowView(bridgeTab, { workspaceId: 'ws-clara', conversationId: 'conv-clara' });

    expect(isBrowserBridgeEvent(bridgeTab)).toBe(true);
    expect(isBrowserBridgeEvent(appWindow)).toBe(false);
    expect(getMainWindowView()).toEqual({ workspaceId: 'ws-java', conversationId: 'conv-java' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('main-window-view-changed', {
      workspaceId: 'ws-java',
      conversationId: 'conv-java',
    });

    // Same view again: no push.
    noteMainWindowView(appWindow, { conversationId: 'conv-java' });
    expect(send).toHaveBeenCalledTimes(1);

    // Switching workspace clears the conversation until the window loads one.
    noteMainWindowView(appWindow, { workspaceId: 'ws-other', conversationId: null });
    expect(getMainWindowView()).toEqual({ workspaceId: 'ws-other', conversationId: null });
  });
});
