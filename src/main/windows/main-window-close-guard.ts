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

/** A guarded main window, and whether its renderer is answering. */
interface GuardedWindow {
  win: BrowserWindow;
  responsive: boolean;
}

/** The close being held for the user's answer, and whether it came from quitting the app. */
let held: { win: BrowserWindow; quit: boolean } | null = null;
/** Windows the user agreed to close with agents running: their next close goes through. */
const confirmed = new WeakSet<BrowserWindow>();
/** The open main window, for the quit hook. */
let guarded: GuardedWindow | null = null;
let quitHookRegistered = false;

/** Agents a close would stop: open chat turns, and sub-agents still running after theirs ended. */
export function runningAgentCount(): number {
  return activeChatStreamCount() + runningSubagentCount();
}

/**
 * Agents the user has to agree to stop before `target` closes, or 0 when the close goes through
 * unasked: nothing is running, the user already agreed, or the renderer cannot answer (crashed,
 * hung or still loading).
 */
function agentsToConfirm(target: GuardedWindow): number {
  const { win } = target;
  if (win.isDestroyed() || confirmed.has(win)) {
    return 0;
  }
  const contents = win.webContents;
  if (!target.responsive || contents.isDestroyed() || contents.isCrashed() || contents.isLoading()) {
    return 0;
  }
  return runningAgentCount();
}

/** Remember the close (or quit) being held and ask the renderer to show its confirm dialog. */
function hold(win: BrowserWindow, quit: boolean, runningAgents: number): void {
  // A held quit stays a quit when the window is asked to close again before the answer.
  held = { win, quit: quit || (held?.win === win && held.quit) };
  if (win.isMinimized()) {
    win.restore();
  }
  win.show();
  win.focus();
  const request: AppCloseConfirmRequest = { runningAgents };
  win.webContents.send(APP_CLOSE_CONFIRM_REQUEST_CHANNEL, request);
}

/**
 * Hold the main window open while an agent is running, until the user confirms in the window.
 *
 * Closing the window (the titlebar button, Alt+F4, the taskbar) is held on its `close` event.
 * Quitting the app (File > Exit, an update's restart) is held earlier, on `before-quit`: once a
 * quit reaches the windows Electron closes every one of them, so cancelling the main window's
 * close there would still take Settings, Health and the other windows with it. A held close is
 * cancelled and the renderer is asked to show its confirm dialog;
 * {@link answerMainWindowCloseConfirm} closes for real. A renderer that cannot answer (crashed,
 * hung or still loading) never holds the window.
 */
export function guardMainWindowClose(win: BrowserWindow): void {
  const target: GuardedWindow = { win, responsive: true };
  guarded = target;
  if (!quitHookRegistered) {
    quitHookRegistered = true;
    app.on('before-quit', (event) => {
      // A quit another handler is already holding (the updater checking its installer) is asked
      // again when that handler quits for real.
      if (event.defaultPrevented || !guarded) {
        return;
      }
      const runningAgents = agentsToConfirm(guarded);
      if (runningAgents > 0) {
        event.preventDefault();
        hold(guarded.win, true, runningAgents);
      }
    });
  }
  win.on('unresponsive', () => {
    target.responsive = false;
  });
  win.on('responsive', () => {
    target.responsive = true;
  });
  win.on('close', (event) => {
    const runningAgents = agentsToConfirm(target);
    if (runningAgents > 0) {
      event.preventDefault();
      hold(win, false, runningAgents);
    }
  });
  win.on('closed', () => {
    if (held?.win === win) {
      held = null;
    }
    if (guarded === target) {
      guarded = null;
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
