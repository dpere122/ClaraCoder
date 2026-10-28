import { COMPOSER_RUN_MODES, type ComposerRunMode } from '../shared/types/composer-mode';
import { mainState } from './state';

/** The main window's composer settings that live only in its renderer (model and effort are config). */
export interface MainWindowComposer {
  mode: ComposerRunMode;
  autoApply: boolean;
  /** Admin elevation of the window's current conversation. */
  admin: boolean;
}

/** The workspace and conversation the app's own main window has open. */
export interface MainWindowView {
  workspaceId: string | null;
  conversationId: string | null;
  /** Bumped when the window creates, saves, renames or deletes a conversation (a joined tab relists). */
  conversationsRevision: number;
  composer: MainWindowComposer | null;
}

const view: MainWindowView = { workspaceId: null, conversationId: null, conversationsRevision: 0, composer: null };

/**
 * True for an IPC call from a dev browser-bridge tab. Such a tab acts as the main window (same
 * `event.sender`), so config `currentWorkspaceId` and `activeConversationId` follow the tabs too;
 * only {@link MainWindowView} tells what the real window shows.
 */
export function isBrowserBridgeEvent(event: unknown): boolean {
  return !!(event as { fromBrowserBridge?: boolean } | null)?.fromBrowserBridge;
}

/** Record what the main window opened (ignored for bridge tabs); pushes `main-window-view-changed`. */
export function noteMainWindowView(
  event: unknown,
  next: Partial<Omit<MainWindowView, 'conversationsRevision'>>,
  opts?: { conversationsChanged?: boolean },
): void {
  if (isBrowserBridgeEvent(event)) {
    return;
  }
  const merged: MainWindowView = {
    ...view,
    ...next,
    conversationsRevision: view.conversationsRevision + (opts?.conversationsChanged ? 1 : 0),
  };
  if (JSON.stringify(merged) === JSON.stringify(view)) {
    return;
  }
  Object.assign(view, merged);
  const win = mainState.mainWindow;
  if (win && !win.isDestroyed()) {
    // The bridge mirrors this to its main-window tabs, which offer to join the view.
    win.webContents.send('main-window-view-changed', getMainWindowView());
  }
}

/** The main window created, saved, renamed or deleted a conversation (ignored for bridge tabs). */
export function noteMainWindowConversationsChanged(event: unknown): void {
  noteMainWindowView(event, {}, { conversationsChanged: true });
}

/** The composer settings a renderer reported, or null when malformed. */
export function parseMainWindowComposer(raw: unknown): MainWindowComposer | null {
  const c = raw as Partial<MainWindowComposer> | null;
  if (!c || !COMPOSER_RUN_MODES.includes(c.mode as ComposerRunMode)) {
    return null;
  }
  return { mode: c.mode as ComposerRunMode, autoApply: c.autoApply === true, admin: c.admin === true };
}

export function getMainWindowView(): MainWindowView {
  return { ...view, composer: view.composer ? { ...view.composer } : null };
}
