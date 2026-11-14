import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The part of Electron's `before-quit` event the guard reads. */
interface QuitEvent {
  defaultPrevented: boolean;
  preventDefault(): void;
}

const mocks = vi.hoisted(() => ({
  appHandlers: new Map<string, (event: QuitEvent) => void>(),
  quit: vi.fn(),
  streams: 0,
  subagents: 0,
}));

vi.mock('electron', () => ({
  app: {
    on: (event: string, handler: (event: QuitEvent) => void) => mocks.appHandlers.set(event, handler),
    quit: mocks.quit,
  },
}));
vi.mock('../ipc/handlers/chat-stream-state', () => ({ activeChatStreamCount: () => mocks.streams }));
vi.mock('../ipc/handlers/subagent-events', () => ({ runningSubagentCount: () => mocks.subagents }));

import type { BrowserWindow } from 'electron';
import {
  answerMainWindowCloseConfirm,
  APP_CLOSE_CONFIRM_REQUEST_CHANNEL,
  guardMainWindowClose,
} from './main-window-close-guard';

/** A window whose `close()` runs the `close` listeners the way Electron does, then closes unless one cancels. */
function fakeWindow() {
  const emitter = new EventEmitter();
  const send = vi.fn();
  const state = { closed: false, crashed: false, loading: false };
  const win = Object.assign(emitter, {
    webContents: {
      send,
      isDestroyed: () => state.closed,
      isCrashed: () => state.crashed,
      isLoading: () => state.loading,
    },
    isDestroyed: () => state.closed,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    close: () => {
      let prevented = false;
      emitter.emit('close', { preventDefault: () => (prevented = true) });
      if (!prevented) {
        state.closed = true;
        emitter.emit('closed');
      }
    },
  });
  guardMainWindowClose(win as unknown as BrowserWindow);
  return { win, send, state };
}

/**
 * `app.quit()` as Electron runs it: `before-quit`, then every window is asked to close unless a
 * handler cancelled the quit. `heldElsewhere` is another handler having cancelled it first.
 * Returns whether the quit was cancelled before it reached the windows.
 */
function quitThrough(win: { close(): void }, heldElsewhere = false): boolean {
  const event: QuitEvent = {
    defaultPrevented: heldElsewhere,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  mocks.appHandlers.get('before-quit')?.(event);
  if (!event.defaultPrevented) {
    win.close();
  }
  return event.defaultPrevented;
}

describe('guardMainWindowClose', () => {
  beforeEach(() => {
    mocks.quit.mockReset();
    mocks.streams = 0;
    mocks.subagents = 0;
  });

  // The held close is module state: a test that leaves one unanswered must not hand it to the next.
  afterEach(() => {
    answerMainWindowCloseConfirm(false);
  });

  it('closes at once when no agent is running', () => {
    const { win, send, state } = fakeWindow();
    win.close();
    expect(state.closed).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it('holds the close and asks the renderer while a turn or a sub-agent is running', () => {
    mocks.streams = 1;
    mocks.subagents = 2;
    const { win, send, state } = fakeWindow();
    win.close();
    expect(state.closed).toBe(false);
    expect(send).toHaveBeenCalledWith(APP_CLOSE_CONFIRM_REQUEST_CHANNEL, { runningAgents: 3 });
    expect(win.focus).toHaveBeenCalled();
  });

  it('stays open when the user declines, and asks again on the next close', () => {
    mocks.streams = 1;
    const { win, send, state } = fakeWindow();
    win.close();
    answerMainWindowCloseConfirm(false);
    expect(state.closed).toBe(false);
    win.close();
    expect(state.closed).toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('closes the window once the user confirms', () => {
    mocks.streams = 1;
    const { win, state } = fakeWindow();
    win.close();
    answerMainWindowCloseConfirm(true);
    expect(state.closed).toBe(true);
    expect(mocks.quit).not.toHaveBeenCalled();
  });

  it('holds a quit before any window is asked to close', () => {
    mocks.streams = 1;
    const { win, send, state } = fakeWindow();
    const closeAsked = vi.fn();
    win.on('close', closeAsked);

    // Electron closes every window once a quit gets past `before-quit`, so it must stop there.
    expect(quitThrough(win)).toBe(true);
    expect(closeAsked).not.toHaveBeenCalled();
    expect(state.closed).toBe(false);
    expect(send).toHaveBeenCalledWith(APP_CLOSE_CONFIRM_REQUEST_CHANNEL, { runningAgents: 1 });
  });

  it('lets a quit through when no agent is running', () => {
    const { win, send, state } = fakeWindow();
    expect(quitThrough(win)).toBe(false);
    expect(state.closed).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it('resumes a held quit as a quit, and lets its close through', () => {
    mocks.streams = 1;
    const { win, send, state } = fakeWindow();
    quitThrough(win);
    expect(state.closed).toBe(false);

    answerMainWindowCloseConfirm(true);
    expect(mocks.quit).toHaveBeenCalledTimes(1);
    quitThrough(win);
    expect(state.closed).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not treat a later window close as a quit after a quit was declined', () => {
    mocks.streams = 1;
    const { win, state } = fakeWindow();
    quitThrough(win);
    answerMainWindowCloseConfirm(false);

    win.close();
    answerMainWindowCloseConfirm(true);
    expect(state.closed).toBe(true);
    expect(mocks.quit).not.toHaveBeenCalled();
  });

  it('keeps a held quit a quit when the window is closed again before the answer', () => {
    mocks.streams = 1;
    const { win, send } = fakeWindow();
    quitThrough(win);
    win.close();
    expect(send).toHaveBeenCalledTimes(2);

    answerMainWindowCloseConfirm(true);
    expect(mocks.quit).toHaveBeenCalledTimes(1);
  });

  it('leaves a quit another handler is holding, and asks when that handler quits for real', () => {
    mocks.streams = 1;
    const { win, send, state } = fakeWindow();
    quitThrough(win, true);
    expect(send).not.toHaveBeenCalled();

    expect(quitThrough(win)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(state.closed).toBe(false);
  });

  it('never holds a window whose renderer cannot answer', () => {
    mocks.streams = 1;
    const crashed = fakeWindow();
    crashed.state.crashed = true;
    crashed.win.close();
    expect(crashed.state.closed).toBe(true);

    const loading = fakeWindow();
    loading.state.loading = true;
    loading.win.close();
    expect(loading.state.closed).toBe(true);

    const hung = fakeWindow();
    hung.win.emit('unresponsive');
    hung.win.close();
    expect(hung.state.closed).toBe(true);

    const quitting = fakeWindow();
    quitting.state.crashed = true;
    expect(quitThrough(quitting.win)).toBe(false);
    expect(quitting.state.closed).toBe(true);
  });

  it('ignores an answer when no close is held', () => {
    const { state } = fakeWindow();
    answerMainWindowCloseConfirm(true);
    expect(state.closed).toBe(false);
    expect(mocks.quit).not.toHaveBeenCalled();
  });
});
