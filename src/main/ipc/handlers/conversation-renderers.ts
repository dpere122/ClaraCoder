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

/** `event.reply`, falling back to the main window once that frame is gone (e.g. the renderer reloaded). */
function replyOrMainWindow(event: Electron.IpcMainEvent): RendererSend {
  return (channel, ...args) => {
    const frame = event.senderFrame as { detached?: boolean } | null | undefined;
    if (!frame || frame.detached || event.sender?.isDestroyed?.()) {
      sendToMainWindow(channel, ...args);
      return;
    }
    try {
      event.reply(channel, ...args);
    } catch {
      sendToMainWindow(channel, ...args);
    }
  };
}

/** Remember the renderer of a chat turn (called for every `message` IPC). */
export function rememberConversationRenderer(conversationId: string, event: Electron.IpcMainEvent): void {
  renderers.set(conversationId, replyOrMainWindow(event));
}

/** Where to deliver events about `conversationId`: its last turn's renderer, else the main window. */
export function conversationRenderer(conversationId: string): RendererSend {
  return renderers.get(conversationId) ?? sendToMainWindow;
}

export function forgetConversationRenderer(conversationId: string): void {
  renderers.delete(conversationId);
}
