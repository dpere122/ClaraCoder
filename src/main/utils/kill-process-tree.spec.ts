import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(() => ({ status: 0 })),
}));

vi.mock('child_process', () => ({
  spawnSync: spawnSyncMock,
}));

import { childHasExited, killPidTree, killProcessTree } from './kill-process-tree';

describe('killProcessTree', () => {
  afterEach(() => {
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: 0 });
    vi.restoreAllMocks();
  });

  it('childHasExited is true when exitCode is set', () => {
    expect(childHasExited({ exitCode: 0, signalCode: null } as ChildProcess)).toBe(true);
    expect(childHasExited({ exitCode: null, signalCode: 'SIGKILL' } as ChildProcess)).toBe(true);
    expect(childHasExited({ exitCode: null, signalCode: null } as ChildProcess)).toBe(false);
  });

  it('skips processes that have already exited', () => {
    const proc = Object.assign(new EventEmitter(), {
      pid: 42,
      exitCode: 1,
      signalCode: null,
    }) as unknown as ChildProcess;
    killProcessTree(proc);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('on win32 uses taskkill /T /F', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    killPidTree(4242);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '4242', '/t', '/f'],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it('on posix sends SIGKILL to the process group', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    killPidTree(99);
    expect(killSpy).toHaveBeenCalledWith(-99, 'SIGKILL');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});
