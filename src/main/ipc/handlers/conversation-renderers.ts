import { mainState } from '../../state';
import type { RendererSend } from './chat-stream-payload';

/**
 * The renderer that sent each conversation's latest chat turn. Events that are not replies to a
 * stream (a sub-agent's, which can outlive the turn that spawned it) go to that renderer only, as
 * the stream's own replies do: with the dev browser bridge the app window and a bridge tab both run
 * a renderer, and both acting on one event would start two turns or save a transcript twice.
 */
const renderers = new Map<string, RendererSend>();

/** The main window's renderer (the bridge mirrors these sends to its tabs). */
export function sendToMainWindow(channel: string, ...args: unknown[]): void {
  const win = mainState.mainWindow;
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, ...args);
  }
}

/** Main-frame page loads per renderer, counted from the first turn it sent. */
const pageLoads = new WeakMap<Electron.WebContents, number>();

function pageLoadCount(wc: Electron.WebContents): number {
  if (!pageLoads.has(wc)) {
    pageLoads.set(wc, 0);
    wc.on('did-navigate', () => pageLoads.set(wc, (pageLoads.get(wc) ?? 0) + 1));
  }
  return pageLoads.get(wc) ?? 0;
}

/**
 * `event.reply` while the page that sent the turn is still loaded. After a reload `event.reply`
 * is silently dropped (the frame object survives, so it cannot tell), so the renderer's current
 * page gets `webContents.send` instead; it rejoins the turn when it opens the conversation. Once
 * the renderer is gone, the main window.
 */
export function replyToTurnRenderer(event: Electron.IpcMainEvent): RendererSend {
  const wc = event.sender;
  const loadAtTurnStart = wc && !wc.isDestroyed() ? pageLoadCount(wc) : 0;
  return (channel, ...args) => {
    if (!wc || wc.isDestroyed()) {
      sendToMainWindow(channel, ...args);
      return;
    }
    if (pageLoadCount(wc) !== loadAtTurnStart) {
      wc.send(channel, ...args);
      return;
    }
    try {
      event.reply(channel, ...args);
    } catch {
      wc.send(channel, ...args);
    }
  };
}

/** Remember the renderer of a chat turn (called for every `message` IPC); returns its send. */
export function rememberConversationRenderer(conversationId: string, event: Electron.IpcMainEvent): RendererSend {
  const send = replyToTurnRenderer(event);
  renderers.set(conversationId, send);
  return send;
}

/** Where to deliver events about `conversationId`: its last turn's renderer, else the main window. */
export function conversationRenderer(conversationId: string): RendererSend {
  return renderers.get(conversationId) ?? sendToMainWindow;
}

export function forgetConversationRenderer(conversationId: string): void {
  renderers.delete(conversationId);
}
