import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(() => ({ status: 0 })),
}));

vi.mock('child_process', () => ({
  spawnSync: spawnSyncMock,
}));

import {
  getLlamaServerStopGraceMs,
  setLlamaServerStopGraceMs,
  stopLlamaServerPid,
} from './stop-llama-server';

describe('stopLlamaServerPid', () => {
  afterEach(() => {
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: 0 });
    setLlamaServerStopGraceMs(15_000);
    vi.restoreAllMocks();
  });

  it('does not force-kill when the process is already gone', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: 'INFO: No tasks are running which match the specified criteria.\r\n',
    } as never);
    expect(stopLlamaServerPid(4242)).toBe('exited');
    expect(spawnSyncMock).not.toHaveBeenCalledWith('taskkill', expect.anything(), expect.anything());
    expect(spawnSyncMock).not.toHaveBeenCalledWith('powershell.exe', expect.anything(), expect.anything());
  });

  it('on win32 sends one CTRL_C and does not force-kill if the server exits', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    setLlamaServerStopGraceMs(0);
    let listed = true;
    spawnSyncMock.mockImplementation(((cmd: string) => {
      if (cmd === 'tasklist') {
        return {
          status: 0,
          stdout: listed
            ? '"llama-server.exe","4242","Console","1","1,234 K"\r\n'
            : 'INFO: No tasks are running which match the specified criteria.\r\n',
        };
      }
      if (cmd === 'powershell.exe') {
        listed = false;
        return { status: 0 };
      }
      return { status: 0 };
    }) as never);

    expect(stopLlamaServerPid(4242)).toBe('graceful');
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining(['-Command', expect.stringContaining('GenerateConsoleCtrlEvent(0, 0)')]),
      expect.anything(),
    );
    expect(spawnSyncMock).not.toHaveBeenCalledWith('taskkill', expect.anything(), expect.anything());
  });

  it('force-kills only after the grace period if CTRL_C does not stop the server', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    setLlamaServerStopGraceMs(0);
    spawnSyncMock.mockImplementation(((cmd: string) => {
      if (cmd === 'tasklist') {
        return {
          status: 0,
          stdout: '"llama-server.exe","4242","Console","1","1,234 K"\r\n',
        };
      }
      return { status: 0 };
    }) as never);

    expect(stopLlamaServerPid(4242)).toBe('forced');
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '4242', '/t', '/f'],
      expect.objectContaining({ windowsHide: true }),
    );
    expect(getLlamaServerStopGraceMs()).toBe(0);
  });

  it('on posix sends SIGTERM to the process group before any SIGKILL', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    setLlamaServerStopGraceMs(0);
    let listed = true;
    spawnSyncMock.mockImplementation(((cmd: string) => {
      if (cmd === 'ps') {
        return listed ? { status: 0, stdout: 'llama-server\n' } : { status: 1, stdout: '' };
      }
      return { status: 0 };
    }) as never);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (signal === 'SIGTERM') {
        listed = false;
      }
      return true;
    });

    expect(stopLlamaServerPid(99)).toBe('graceful');
    expect(killSpy).toHaveBeenCalledWith(-99, 'SIGTERM');
    expect(killSpy).not.toHaveBeenCalledWith(-99, 'SIGKILL');
  });
});
