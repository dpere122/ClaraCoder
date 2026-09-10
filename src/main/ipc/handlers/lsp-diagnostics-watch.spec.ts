import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => void>(),
  pythonControlFetch: vi.fn(),
  send: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    on: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
      mocks.handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../assert-trusted-renderer', () => ({
  assertTrustedMainRenderer: vi.fn(),
}));

vi.mock('../../python/http-client', () => ({
  pythonControlFetch: mocks.pythonControlFetch,
}));

vi.mock('../../state', () => ({
  mainState: {
    mainWindow: {
      webContents: { send: mocks.send },
    },
  },
}));

import { registerLspDiagnosticsWatchIpc } from './lsp-diagnostics-watch';

function deferredResponse() {
  let resolve!: (value: { ok: boolean; json: () => Promise<{ generation: number; epoch: number }> }) => void;
  const promise = new Promise<{ ok: boolean; json: () => Promise<{ generation: number; epoch: number }> }>(
    (done) => {
      resolve = done;
    },
  );
  return { promise, resolve };
}

describe('LSP diagnostics watch focus changes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.handlers.clear();
    mocks.pythonControlFetch.mockReset();
    mocks.send.mockReset();
    registerLspDiagnosticsWatchIpc();
  });

  it('discards an in-flight response from the previously focused tab', async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    mocks.pythonControlFetch
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const start = mocks.handlers.get('lsp-diagnostics-watch-start')!;
    const stop = mocks.handlers.get('lsp-diagnostics-watch-stop')!;
    start({}, 'session-1', 'src/a.ts');
    start({}, 'session-1', 'src/b.ts');

    first.resolve({
      ok: true,
      json: async () => ({ generation: 4, epoch: 1 }),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.send).not.toHaveBeenCalled();

    second.resolve({
      ok: true,
      json: async () => ({ generation: 7, epoch: 2 }),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.send).toHaveBeenCalledWith('lsp-diagnostics-updated', {
      sessionId: 'session-1',
      relativePath: 'src/b.ts',
      generation: 7,
      epoch: 2,
    });

    stop({});
    vi.useRealTimers();
  });
});
