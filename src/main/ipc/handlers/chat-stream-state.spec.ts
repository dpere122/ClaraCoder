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
