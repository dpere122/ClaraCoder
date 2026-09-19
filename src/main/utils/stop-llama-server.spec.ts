import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnSyncMock, spawnMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(() => ({ status: 0 })),
  spawnMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

import {
  getLlamaServerStopGraceMs,
  setLlamaServerStopGraceMs,
  stopLlamaServerChildAsync,
  stopLlamaServerPid,
  stopLlamaServerPidAsync,
} from './stop-llama-server';

type FakeChild = EventEmitter & { pid: number; exitCode: number | null; signalCode: string | null; kill: () => void };

function fakeChild(pid: number): FakeChild {
  const p = new EventEmitter() as FakeChild;
  p.pid = pid;
  p.exitCode = null;
  p.signalCode = null;
  p.kill = vi.fn();
  return p;
}

/** ``spawn`` stand-in for the PowerShell CTRL_C helper: exits ``code`` on the next tick. */
function powershellExits(code: number, onSpawn?: () => void): void {
  spawnMock.mockImplementation((() => {
    onSpawn?.();
    const p = fakeChild(777);
    setTimeout(() => p.emit('close', code), 0);
    return p;
  }) as never);
}

describe('stopLlamaServerPid', () => {
  afterEach(() => {
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: 0 });
    spawnMock.mockReset();
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

describe('stopLlamaServerChildAsync', () => {
  afterEach(() => {
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: 0 });
    spawnMock.mockReset();
    setLlamaServerStopGraceMs(15_000);
    vi.restoreAllMocks();
  });

  it('returns exited without signalling when the child is already gone', async () => {
    const child = fakeChild(4242);
    child.exitCode = 0;
    await expect(stopLlamaServerChildAsync(child as unknown as ChildProcess)).resolves.toBe('exited');
    expect(spawnMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('on win32 delivers CTRL_C through spawn (never spawnSync) and resolves graceful on exit', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    setLlamaServerStopGraceMs(5_000);
    const child = fakeChild(4242);
    powershellExits(0, () => {
      // llama-server unloads and exits shortly after the interrupt lands.
      setTimeout(() => {
        child.exitCode = 0;
        child.emit('exit', 0, null);
      }, 5);
    });

    await expect(stopLlamaServerChildAsync(child as unknown as ChildProcess)).resolves.toBe('graceful');
    expect(spawnMock).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining(['-Command', expect.stringContaining('GenerateConsoleCtrlEvent(0, 0)')]),
      expect.objectContaining({ windowsHide: true }),
    );
    expect(spawnSyncMock).not.toHaveBeenCalledWith('powershell.exe', expect.anything(), expect.anything());
    expect(spawnSyncMock).not.toHaveBeenCalledWith('taskkill', expect.anything(), expect.anything());
  });

  it('does not block the event loop while waiting out the grace period', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    setLlamaServerStopGraceMs(120);
    powershellExits(0);
    const child = fakeChild(4242);

    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 10);
    try {
      await expect(stopLlamaServerChildAsync(child as unknown as ChildProcess)).resolves.toBe('forced');
    } finally {
      clearInterval(ticker);
    }
    // A synchronous Atomics.wait would have starved the interval entirely.
    expect(ticks).toBeGreaterThan(3);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '4242', '/t', '/f'],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it('on posix sends SIGTERM to the group and only SIGKILLs after the grace period', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    setLlamaServerStopGraceMs(0);
    const child = fakeChild(99);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    await expect(stopLlamaServerChildAsync(child as unknown as ChildProcess)).resolves.toBe('forced');
    expect(killSpy).toHaveBeenCalledWith(-99, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(-99, 'SIGKILL');
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('stopLlamaServerPidAsync', () => {
  afterEach(() => {
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: 0 });
    spawnMock.mockReset();
    setLlamaServerStopGraceMs(15_000);
    vi.restoreAllMocks();
  });

  it('skips a PID that no longer belongs to llama-server', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: '"notepad.exe","4242","Console","1","1,234 K"\r\n',
    } as never);
    await expect(stopLlamaServerPidAsync(4242)).resolves.toBe('exited');
    expect(spawnMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalledWith('taskkill', expect.anything(), expect.anything());
  });

  it('resolves graceful once tasklist stops reporting the server', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    setLlamaServerStopGraceMs(2_000);
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
      return { status: 0 };
    }) as never);
    powershellExits(0, () => {
      listed = false;
    });

    await expect(stopLlamaServerPidAsync(4242)).resolves.toBe('graceful');
    expect(spawnSyncMock).not.toHaveBeenCalledWith('taskkill', expect.anything(), expect.anything());
  });
});
