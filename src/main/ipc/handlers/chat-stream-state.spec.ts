import { describe, it, expect, vi, beforeEach } from 'vitest';

const { pythonControlFetch } = vi.hoisted(() => ({
  pythonControlFetch: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../../python/http-client', () => ({
  pythonControlFetch,
}));

import {
  abortChatStream,
  beginChatStream,
  endChatStream,
  forgetWaitingCard,
  getLiveTurn,
  rememberWaitingCard,
  wasChatStreamSuperseded,
} from './chat-stream-state';

describe('abortChatStream', () => {
  beforeEach(() => {
    pythonControlFetch.mockReset();
    pythonControlFetch.mockResolvedValue({ ok: true });
  });

  it('aborts the SSE controller and POSTs /chat/abort so llama-server generation stops', async () => {
    const controller = beginChatStream('conv-1', 'ws-1');
    const abortSpy = vi.spyOn(controller, 'abort');

    const result = await abortChatStream('conv-1');

    expect(result).toEqual({ ok: true });
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(pythonControlFetch).toHaveBeenCalledWith('/chat/abort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'conv-1' }),
    });
  });

  it('still POSTs /chat/abort when no local SSE controller is registered', async () => {
    const result = await abortChatStream('conv-missing');
    expect(result).toEqual({ ok: true });
    expect(pythonControlFetch).toHaveBeenCalledWith('/chat/abort', expect.any(Object));
  });

  it('returns no active stream only when there is no controller and the Python abort fails', async () => {
    pythonControlFetch.mockRejectedValue(new Error('offline'));
    const result = await abortChatStream('conv-offline');
    expect(result).toEqual({ ok: false, error: 'No active stream' });
  });

  it('does not abort a replacement stream when the original ends', async () => {
    const first = beginChatStream('conv-2', null);
    const second = beginChatStream('conv-2', null);
    endChatStream('conv-2', first);
    const abortSecond = vi.spyOn(second, 'abort');

    await abortChatStream('conv-2');
    expect(abortSecond).toHaveBeenCalledTimes(1);
  });
});

describe('wasChatStreamSuperseded', () => {
  it('marks the previous stream when a newer one replaces it, so its done is not forwarded', () => {
    const first = beginChatStream('conv-3', null);
    const second = beginChatStream('conv-3', null);

    expect(first.signal.aborted).toBe(true);
    expect(wasChatStreamSuperseded(first)).toBe(true);
    expect(wasChatStreamSuperseded(second)).toBe(false);
    endChatStream('conv-3', second);
  });

  it('does not mark a stream the user aborted (that done must still settle the turn)', async () => {
    const controller = beginChatStream('conv-4', null);
    await abortChatStream('conv-4');

    expect(controller.signal.aborted).toBe(true);
    expect(wasChatStreamSuperseded(controller)).toBe(false);
  });
});

describe('getLiveTurn', () => {
  const card = (requestId: string) => ({ channel: 'message-accept-command', payload: { requestId } });

  it('reports the turn and the cards it still waits on, so a reloaded renderer can rejoin', () => {
    const controller = beginChatStream('conv-live', null, 'user-msg-1');
    rememberWaitingCard('conv-live', card('req-1'));
    rememberWaitingCard('conv-live', card('req-2'));
    forgetWaitingCard('conv-live', 'req-1');

    expect(getLiveTurn('conv-live')).toEqual({ userMessageId: 'user-msg-1', waitingCards: [card('req-2')] });
    endChatStream('conv-live', controller);
  });

  it('is null once the stream ends or is aborted', async () => {
    const controller = beginChatStream('conv-ended', null, 'u');
    rememberWaitingCard('conv-ended', card('req'));
    endChatStream('conv-ended', controller);
    expect(getLiveTurn('conv-ended')).toBeNull();

    beginChatStream('conv-aborted', null, 'u');
    await abortChatStream('conv-aborted');
    expect(getLiveTurn('conv-aborted')).toBeNull();
  });

  it('starts a replacement stream without the cards of the turn it replaced', () => {
    beginChatStream('conv-replaced', null, 'old');
    rememberWaitingCard('conv-replaced', card('req-old'));
    const second = beginChatStream('conv-replaced', null, 'new');

    expect(getLiveTurn('conv-replaced')).toEqual({ userMessageId: 'new', waitingCards: [] });
    endChatStream('conv-replaced', second);
  });

  it('ignores cards for a conversation with no live turn', () => {
    rememberWaitingCard('conv-none', card('req'));
    expect(getLiveTurn('conv-none')).toBeNull();
  });
});
