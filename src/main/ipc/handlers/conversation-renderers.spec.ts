import { EventEmitter } from 'events';
import { describe, it, expect, vi } from 'vitest';

const { mainState } = vi.hoisted(() => ({
  mainState: { mainWindow: null as unknown },
}));

vi.mock('../../state', () => ({ mainState }));

import { replyToTurnRenderer } from './conversation-renderers';

function fakeTurn() {
  const wc = Object.assign(new EventEmitter(), { send: vi.fn(), isDestroyed: vi.fn(() => false) });
  const event = { sender: wc, reply: vi.fn() } as unknown as Electron.IpcMainEvent;
  return { wc, event, reply: event.reply as ReturnType<typeof vi.fn> };
}

describe('replyToTurnRenderer', () => {
  it('replies to the page that sent the turn while it is still loaded', () => {
    const { wc, event, reply } = fakeTurn();
    const send = replyToTurnRenderer(event);

    send('message-chunk', 'conv', 'hi');

    expect(reply).toHaveBeenCalledWith('message-chunk', 'conv', 'hi');
    expect(wc.send).not.toHaveBeenCalled();
  });

  it('sends to the reloaded page: event.reply would be dropped after a reload', () => {
    const { wc, event, reply } = fakeTurn();
    const send = replyToTurnRenderer(event);

    wc.emit('did-navigate');
    send('message-accept-command', 'conv', { requestId: 'r' });

    expect(wc.send).toHaveBeenCalledWith('message-accept-command', 'conv', { requestId: 'r' });
    expect(reply).not.toHaveBeenCalled();
  });

  it('a turn started after a reload replies to its own page again', () => {
    const { wc, event, reply } = fakeTurn();
    replyToTurnRenderer(event);
    wc.emit('did-navigate');

    replyToTurnRenderer(event)('message-done', 'conv');

    expect(reply).toHaveBeenCalledWith('message-done', 'conv');
  });

  it('falls back to the main window once the renderer is destroyed', () => {
    const { wc, event, reply } = fakeTurn();
    const mainSend = vi.fn();
    mainState.mainWindow = { isDestroyed: () => false, webContents: { send: mainSend } };
    const send = replyToTurnRenderer(event);

    wc.isDestroyed.mockReturnValue(true);
    send('message-done', 'conv');

    expect(mainSend).toHaveBeenCalledWith('message-done', 'conv');
    expect(reply).not.toHaveBeenCalled();
    mainState.mainWindow = null;
  });
});
