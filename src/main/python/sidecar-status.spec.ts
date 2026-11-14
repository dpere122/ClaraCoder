import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SidecarStartupState } from '../../shared';

type SidecarStatus = typeof import('./sidecar-status');

/** A restart the test finishes by hand. */
function pendingRestart() {
  let finish: () => void = () => undefined;
  let fail: (err: Error) => void = () => undefined;
  const started = vi.fn();
  const restart = (): Promise<void> => {
    started();
    return new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
  };
  return { restart, started, finish: () => finish(), fail: (err: Error) => fail(err) };
}

/** Lets queued restarts and their state changes run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

describe('runSidecarRestart', () => {
  let status: SidecarStatus;
  let pushed: SidecarStartupState[];

  beforeEach(async () => {
    vi.resetModules();
    pushed = [];
    // The module instance the fresh `sidecar-status` reads its window from.
    const { mainState } = await import('../state');
    mainState.mainWindow = {
      isDestroyed: () => false,
      webContents: { send: (_channel: string, state: SidecarStartupState) => pushed.push(state) },
    } as unknown as typeof mainState.mainWindow;
    status = await import('./sidecar-status');
    status.setSidecarStartupState('ready');
    pushed.length = 0;
  });

  it('holds the state at starting for the restart and settles on its outcome', async () => {
    const first = pendingRestart();
    const done = status.runSidecarRestart(first.restart);
    await settle();
    expect(status.getSidecarStartupState()).toBe('starting');

    first.finish();
    await done;
    expect(pushed).toEqual(['starting', 'ready']);
  });

  it('reports a failed restart and passes the error on', async () => {
    const first = pendingRestart();
    const done = status.runSidecarRestart(first.restart);
    await settle();

    first.fail(new Error('no sidecar'));
    await expect(done).rejects.toThrow('no sidecar');
    expect(pushed).toEqual(['starting', 'failed']);
  });

  it('runs overlapping restarts one at a time and stays starting until the last one ends', async () => {
    const first = pendingRestart();
    const second = pendingRestart();
    const firstDone = status.runSidecarRestart(first.restart);
    const secondDone = status.runSidecarRestart(second.restart);
    await settle();
    expect(first.started).toHaveBeenCalledTimes(1);
    expect(second.started).not.toHaveBeenCalled();

    first.finish();
    await firstDone;
    await settle();
    expect(second.started).toHaveBeenCalledTimes(1);
    expect(status.getSidecarStartupState()).toBe('starting');

    second.finish();
    await secondDone;
    expect(pushed).toEqual(['starting', 'ready']);
  });

  it('still runs the next restart after one fails, and takes the last outcome', async () => {
    const first = pendingRestart();
    const second = pendingRestart();
    const firstDone = status.runSidecarRestart(first.restart);
    const secondDone = status.runSidecarRestart(second.restart);
    await settle();

    first.fail(new Error('exited early'));
    await expect(firstDone).rejects.toThrow('exited early');
    await settle();
    expect(second.started).toHaveBeenCalledTimes(1);
    expect(status.getSidecarStartupState()).toBe('starting');

    second.finish();
    await secondDone;
    expect(pushed).toEqual(['starting', 'ready']);
  });
});
