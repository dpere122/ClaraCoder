import { app, type BrowserWindow } from 'electron';
import { activeChatStreamCount } from '../ipc/handlers/chat-stream-state';
import { runningSubagentCount } from '../ipc/handlers/subagent-events';

/** Main to renderer: an agent is running, ask the user before the window closes. */
export const APP_CLOSE_CONFIRM_REQUEST_CHANNEL = 'app-close-confirm-request';
/** Renderer to main: the user's answer (`true` closes and stops the agents). */
export const APP_CLOSE_CONFIRM_ANSWER_CHANNEL = 'app-close-confirm-answer';

/** What the renderer is told when a close is held. */
export interface AppCloseConfirmRequest {
  /** Agents the close would stop. */
  runningAgents: number;
}

/** The close being held for the user's answer, and whether it came from quitting the app. */
let held: { win: BrowserWindow; quit: boolean } | null = null;
/** Windows the user agreed to close with agents running: their next close goes through. */
const confirmed = new WeakSet<BrowserWindow>();
/** Set by `before-quit` and read by the close it causes, so a confirmed quit resumes as a quit. */
let quitting = false;
let quitHookRegistered = false;

/** Agents a close would stop: open chat turns, and sub-agents still running after theirs ended. */
export function runningAgentCount(): number {
  return activeChatStreamCount() + runningSubagentCount();
}

/**
 * Hold the main window open while an agent is running, until the user confirms in the window.
 *
 * Every way out goes through the window's `close` event (the titlebar button, File > Exit, Alt+F4,
 * the taskbar), so the check lives here and not in the renderer. A held close is cancelled and the
 * renderer is asked to show its confirm dialog; {@link answerMainWindowCloseConfirm} closes for
 * real. A renderer that cannot answer (crashed, hung or still loading) never holds the window.
 */
export function guardMainWindowClose(win: BrowserWindow): void {
  if (!quitHookRegistered) {
    quitHookRegistered = true;
    app.on('before-quit', () => {
      quitting = true;
    });
  }
  let responsive = true;
  win.on('unresponsive', () => {
    responsive = false;
  });
  win.on('responsive', () => {
    responsive = true;
  });
  win.on('close', (event) => {
    const quit = quitting;
    quitting = false;
    if (confirmed.has(win)) {
      return;
    }
    const runningAgents = runningAgentCount();
    const contents = win.webContents;
    if (runningAgents === 0 || !responsive || contents.isDestroyed() || contents.isCrashed() || contents.isLoading()) {
      return;
    }
    // Cancelling the close also cancels a quit in progress; the answer resumes whichever it was.
    event.preventDefault();
    held = { win, quit };
    if (win.isMinimized()) {
      win.restore();
    }
    win.show();
    win.focus();
    const request: AppCloseConfirmRequest = { runningAgents };
    contents.send(APP_CLOSE_CONFIRM_REQUEST_CHANNEL, request);
  });
  win.on('closed', () => {
    if (held?.win === win) {
      held = null;
    }
  });
}

/** The user answered the confirm dialog: close (or quit) as first asked, or stay open. */
export function answerMainWindowCloseConfirm(proceed: boolean): void {
  const pending = held;
  held = null;
  if (!pending || !proceed || pending.win.isDestroyed()) {
    return;
  }
  confirmed.add(pending.win);
  if (pending.quit) {
    app.quit();
  } else {
    pending.win.close();
  }
}
