import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(() => ({ status: 0 })),
}));

vi.mock('child_process', () => ({
  spawnSync: spawnSyncMock,
}));

import { childHasExited, killPidTree, killProcessTree, processImageName } from './kill-process-tree';

describe('processImageName', () => {
  afterEach(() => {
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: 0 });
    vi.restoreAllMocks();
  });

  it('parses the tasklist CSV row on win32', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: '"Llama-Server.exe","4242","Console","1","1,234 K"\r\n',
    } as never);
    expect(processImageName(4242)).toBe('llama-server.exe');
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'tasklist',
      ['/fi', 'PID eq 4242', '/fo', 'csv', '/nh'],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it('returns null when tasklist reports no matching process', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: 'INFO: No tasks are running which match the specified criteria.\r\n',
    } as never);
    expect(processImageName(4242)).toBeNull();
  });

  it('uses ps on posix and strips a macOS-style full path', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '/opt/clara/bin/llama-server\n' } as never);
    expect(processImageName(99)).toBe('llama-server');
    expect(spawnSyncMock).toHaveBeenCalledWith('ps', ['-p', '99', '-o', 'comm='], expect.anything());
  });

  it('returns null for a dead pid or a failed lookup', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '' } as never);
    expect(processImageName(99)).toBeNull();
    spawnSyncMock.mockReturnValue({ error: new Error('ENOENT') } as never);
    expect(processImageName(99)).toBeNull();
    expect(processImageName(0)).toBeNull();
  });
});

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
