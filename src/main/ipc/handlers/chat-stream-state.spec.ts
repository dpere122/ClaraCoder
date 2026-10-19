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
