import { mainState } from './state';

/** The workspace and conversation the app's own main window has open. */
export interface MainWindowView {
  workspaceId: string | null;
  conversationId: string | null;
}

const view: MainWindowView = { workspaceId: null, conversationId: null };

/**
 * True for an IPC call from a dev browser-bridge tab. Such a tab acts as the main window (same
 * `event.sender`), so config `currentWorkspaceId` and `activeConversationId` follow the tabs too;
 * only {@link MainWindowView} tells what the real window shows.
 */
export function isBrowserBridgeEvent(event: unknown): boolean {
  return !!(event as { fromBrowserBridge?: boolean } | null)?.fromBrowserBridge;
}

/** Record what the main window opened (ignored for bridge tabs); pushes `main-window-view-changed`. */
export function noteMainWindowView(event: unknown, next: Partial<MainWindowView>): void {
  if (isBrowserBridgeEvent(event)) {
    return;
  }
  const merged = { ...view, ...next };
  if (merged.workspaceId === view.workspaceId && merged.conversationId === view.conversationId) {
    return;
  }
  Object.assign(view, merged);
  const win = mainState.mainWindow;
  if (win && !win.isDestroyed()) {
    // The bridge mirrors this to its main-window tabs, which offer to join the view.
    win.webContents.send('main-window-view-changed', getMainWindowView());
  }
}

export function getMainWindowView(): MainWindowView {
  return { ...view };
}
