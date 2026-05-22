import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import * as path from 'path';
import { existsSync } from 'fs';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../state', () => ({
  mainState: {
    mainWindow: {
      webContents: {
        send: vi.fn(),
      },
    },
  },
}));

vi.mock('../../utils/workspace-pty-cwd', () => ({
  validateWorkspacePtyCwd: vi.fn(),
}));

import { ipcMain } from 'electron';
import * as pty from 'node-pty';
import { mainState } from '../../state';
import { validateWorkspacePtyCwd } from '../../utils/workspace-pty-cwd';
import { registerWorkspacePtyIpc, killAllWorkspacePtySessions } from './workspace-pty';

describe('workspace-pty', () => {
  let handlers: Map<string, (...args: unknown[]) => Promise<unknown>>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map();
    (ipcMain.handle as Mock).mockImplementation((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, handler);
    });
  });

  afterEach(() => {
    killAllWorkspacePtySessions();
  });

  describe('registerWorkspacePtyIpc', () => {
    it('registers all expected IPC handlers', () => {
      registerWorkspacePtyIpc();

      expect(handlers.has('workspace-pty-spawn')).toBe(true);
      expect(handlers.has('workspace-pty-write')).toBe(true);
      expect(handlers.has('workspace-pty-resize')).toBe(true);
      expect(handlers.has('workspace-pty-kill')).toBe(true);
      expect(handlers.has('workspace-pty-kill-all')).toBe(true);
    });
  });

  describe('workspace-pty-spawn', () => {
    beforeEach(() => {
      registerWorkspacePtyIpc();
    });

    it('returns error when cwd validation fails', async () => {
      (validateWorkspacePtyCwd as Mock).mockResolvedValue({
        ok: false,
        error: 'Working directory must be inside the open workspace',
      });

      const handler = handlers.get('workspace-pty-spawn')!;
      const result = await handler({}, '/workspace', '/outside/path', 80, 24);

      expect(result).toEqual({
        success: false,
        error: 'Working directory must be inside the open workspace',
      });
    });

    it('returns error when workspaceRoot is empty', async () => {
      (validateWorkspacePtyCwd as Mock).mockResolvedValue({
        ok: false,
        error: 'Workspace root is required',
      });

      const handler = handlers.get('workspace-pty-spawn')!;
      const result = await handler({}, '', '/some/path', 80, 24);

      expect(result).toEqual({ success: false, error: 'Workspace root is required' });
    });

    it('spawns PTY with validated cwd on success', async () => {
      const mockPty = {
        pid: 12345,
        onData: vi.fn(),
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      };
      (validateWorkspacePtyCwd as Mock).mockResolvedValue({
        ok: true,
        cwdReal: '/validated/cwd',
      });
      (pty.spawn as Mock).mockReturnValue(mockPty);
      (existsSync as Mock).mockReturnValue(true);

      const handler = handlers.get('workspace-pty-spawn')!;
      const result = await handler({}, '/workspace', '/workspace/subdir', 80, 24);

      expect(result).toMatchObject({ success: true });
      expect((result as { sessionId: string }).sessionId).toMatch(/^pty-\d+-/);
      expect(pty.spawn).toHaveBeenCalled();
    });

    it('uses xterm-256color terminal name for color support', async () => {
      const mockPty = {
        pid: 12345,
        onData: vi.fn(),
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      };
      (validateWorkspacePtyCwd as Mock).mockResolvedValue({ ok: true, cwdReal: '/cwd' });
      (pty.spawn as Mock).mockReturnValue(mockPty);
      (existsSync as Mock).mockReturnValue(true);

      const handler = handlers.get('workspace-pty-spawn')!;
      await handler({}, '/workspace', '/workspace', 80, 24);

      const spawnCall = (pty.spawn as Mock).mock.calls[0];
      expect(spawnCall[2].name).toBe('xterm-256color');
    });

    it('clamps cols to minimum of 2', async () => {
      const mockPty = {
        pid: 12345,
        onData: vi.fn(),
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      };
      (validateWorkspacePtyCwd as Mock).mockResolvedValue({ ok: true, cwdReal: '/cwd' });
      (pty.spawn as Mock).mockReturnValue(mockPty);
      (existsSync as Mock).mockReturnValue(true);

      const handler = handlers.get('workspace-pty-spawn')!;
      await handler({}, '/workspace', '/workspace', 1, 24);

      const spawnCall = (pty.spawn as Mock).mock.calls[0];
      expect(spawnCall[2].cols).toBe(2);
    });

    it('clamps rows to minimum of 1', async () => {
      const mockPty = {
        pid: 12345,
        onData: vi.fn(),
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      };
      (validateWorkspacePtyCwd as Mock).mockResolvedValue({ ok: true, cwdReal: '/cwd' });
      (pty.spawn as Mock).mockReturnValue(mockPty);
      (existsSync as Mock).mockReturnValue(true);

      const handler = handlers.get('workspace-pty-spawn')!;
      await handler({}, '/workspace', '/workspace', 80, 0);

      const spawnCall = (pty.spawn as Mock).mock.calls[0];
      expect(spawnCall[2].rows).toBe(1);
    });

    it('handles non-number cols/rows by defaulting to 80x24', async () => {
      const mockPty = {
        pid: 12345,
        onData: vi.fn(),
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      };
      (validateWorkspacePtyCwd as Mock).mockResolvedValue({ ok: true, cwdReal: '/cwd' });
      (pty.spawn as Mock).mockReturnValue(mockPty);
      (existsSync as Mock).mockReturnValue(true);

      const handler = handlers.get('workspace-pty-spawn')!;
      await handler({}, '/workspace', '/workspace', 'invalid', null);

      const spawnCall = (pty.spawn as Mock).mock.calls[0];
      expect(spawnCall[2].cols).toBe(80);
      expect(spawnCall[2].rows).toBe(24);
    });

    it('sets PYTHONIOENCODING and PYTHONUTF8 env vars', async () => {
      const mockPty = {
        pid: 12345,
        onData: vi.fn(),
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      };
      (validateWorkspacePtyCwd as Mock).mockResolvedValue({ ok: true, cwdReal: '/cwd' });
      (pty.spawn as Mock).mockReturnValue(mockPty);
      (existsSync as Mock).mockReturnValue(true);

      const handler = handlers.get('workspace-pty-spawn')!;
      await handler({}, '/workspace', '/workspace', 80, 24);

      const spawnCall = (pty.spawn as Mock).mock.calls[0];
      expect(spawnCall[2].env.PYTHONIOENCODING).toBe('utf-8');
      expect(spawnCall[2].env.PYTHONUTF8).toBe('1');
    });

    it('forwards PTY data to renderer via IPC', async () => {
      let dataCallback: ((data: string) => void) | null = null;
      const mockPty = {
        pid: 12345,
        onData: vi.fn((cb: (data: string) => void) => {
          dataCallback = cb;
        }),
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      };
      (validateWorkspacePtyCwd as Mock).mockResolvedValue({ ok: true, cwdReal: '/cwd' });
      (pty.spawn as Mock).mockReturnValue(mockPty);
      (existsSync as Mock).mockReturnValue(true);

      const handler = handlers.get('workspace-pty-spawn')!;
      const result = await handler({}, '/workspace', '/workspace', 80, 24) as { success: true; sessionId: string };

      expect(dataCallback).not.toBeNull();
      dataCallback!('Hello World');

      expect(mainState.mainWindow?.webContents.send).toHaveBeenCalledWith(
        'workspace-pty-data',
        { sessionId: result.sessionId, data: 'Hello World' }
      );
    });

    it('forwards PTY exit to renderer and cleans up session', async () => {
      let exitCallback: ((exit: { exitCode: number; signal?: number }) => void) | null = null;
      const mockPty = {
        pid: 12345,
        onData: vi.fn(),
        onExit: vi.fn((cb: (exit: { exitCode: number; signal?: number }) => void) => {
          exitCallback = cb;
        }),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      };
      (validateWorkspacePtyCwd as Mock).mockResolvedValue({ ok: true, cwdReal: '/cwd' });
      (pty.spawn as Mock).mockReturnValue(mockPty);
      (existsSync as Mock).mockReturnValue(true);

      const handler = handlers.get('workspace-pty-spawn')!;
      const result = await handler({}, '/workspace', '/workspace', 80, 24) as { success: true; sessionId: string };

      exitCallback!({ exitCode: 0, signal: undefined });

      expect(mainState.mainWindow?.webContents.send).toHaveBeenCalledWith(
        'workspace-pty-exit',
        { sessionId: result.sessionId, exitCode: 0, signal: null }
      );
    });

    it('returns error when spawn throws', async () => {
      (validateWorkspacePtyCwd as Mock).mockResolvedValue({ ok: true, cwdReal: '/cwd' });
      (pty.spawn as Mock).mockImplementation(() => {
        throw new Error('PTY spawn failed');
      });
      (existsSync as Mock).mockReturnValue(true);

      const handler = handlers.get('workspace-pty-spawn')!;
      const result = await handler({}, '/workspace', '/workspace', 80, 24);

      expect(result).toMatchObject({ success: false });
      expect((result as { error: string }).error).toContain('PTY spawn failed');
    });
  });

  describe('workspace-pty-write', () => {
    beforeEach(() => {
      registerWorkspacePtyIpc();
    });

    it('returns error for non-existent session', async () => {
      const handler = handlers.get('workspace-pty-write')!;
      const result = await handler({}, 'non-existent-session', 'data');

      expect(result).toEqual({ success: false, error: 'Session not found' });
    });

    it('writes data to existing session', async () => {
      const mockPty = {
        pid: 12345,
        onData: vi.fn(),
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      };
      (validateWorkspacePtyCwd as Mock).mockResolvedValue({ ok: true, cwdReal: '/cwd' });
      (pty.spawn as Mock).mockReturnValue(mockPty);
      (existsSync as Mock).mockReturnValue(true);

      const spawnHandler = handlers.get('workspace-pty-spawn')!;
      const spawnResult = await spawnHandler({}, '/workspace', '/workspace', 80, 24) as { success: true; sessionId: string };

      const writeHandler = handlers.get('workspace-pty-write')!;
      const result = await writeHandler({}, spawnResult.sessionId, 'test input');

      expect(result).toEqual({ success: true });
      expect(mockPty.write).toHaveBeenCalledWith('test input');
    });

    it('handles non-string sessionId', async () => {
      const handler = handlers.get('workspace-pty-write')!;
      const result = await handler({}, 12345, 'data');

      expect(result).toEqual({ success: false, error: 'Session not found' });
    });

    it('handles non-string data by coercing to empty string', async () => {
      const mockPty = {
        pid: 12345,
        onData: vi.fn(),
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      };
      (validateWorkspacePtyCwd as Mock).mockResolvedValue({ ok: true, cwdReal: '/cwd' });
      (pty.spawn as Mock).mockReturnValue(mockPty);
      (existsSync as Mock).mockReturnValue(true);

      const spawnHandler = handlers.get('workspace-pty-spawn')!;
      const spawnResult = await spawnHandler({}, '/workspace', '/workspace', 80, 24) as { success: true; sessionId: string };

      const writeHandler = handlers.get('workspace-pty-write')!;
      await writeHandler({}, spawnResult.sessionId, null);

      expect(mockPty.write).toHaveBeenCalledWith('');
    });
  });

  describe('workspace-pty-resize', () => {
    beforeEach(() => {
      registerWorkspacePtyIpc();
    });

    it('returns error for non-existent session', async () => {
      const handler = handlers.get('workspace-pty-resize')!;
      const result = await handler({}, 'non-existent-session', 100, 30);

      expect(result).toEqual({ success: false, error: 'Session not found' });
    });

    it('resizes existing session', async () => {
      const mockPty = {
        pid: 12345,
        onData: vi.fn(),
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      };
      (validateWorkspacePtyCwd as Mock).mockResolvedValue({ ok: true, cwdReal: '/cwd' });
      (pty.spawn as Mock).mockReturnValue(mockPty);
      (existsSync as Mock).mockReturnValue(true);

      const spawnHandler = handlers.get('workspace-pty-spawn')!;
      const spawnResult = await spawnHandler({}, '/workspace', '/workspace', 80, 24) as { success: true; sessionId: string };

      const resizeHandler = handlers.get('workspace-pty-resize')!;
      const result = await resizeHandler({}, spawnResult.sessionId, 120, 40);

      expect(result).toEqual({ success: true });
      expect(mockPty.resize).toHaveBeenCalledWith(120, 40);
    });

    it('clamps cols to minimum of 2 on resize', async () => {
      const mockPty = {
        pid: 12345,
        onData: vi.fn(),
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      };
      (validateWorkspacePtyCwd as Mock).mockResolvedValue({ ok: true, cwdReal: '/cwd' });
      (pty.spawn as Mock).mockReturnValue(mockPty);
      (existsSync as Mock).mockReturnValue(true);

      const spawnHandler = handlers.get('workspace-pty-spawn')!;
      const spawnResult = await spawnHandler({}, '/workspace', '/workspace', 80, 24) as { success: true; sessionId: string };

      const resizeHandler = handlers.get('workspace-pty-resize')!;
      await resizeHandler({}, spawnResult.sessionId, 0, 40);

      expect(mockPty.resize).toHaveBeenCalledWith(2, 40);
    });

    it('defaults to 80x24 for non-numeric dimensions', async () => {
      const mockPty = {
        pid: 12345,
        onData: vi.fn(),
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      };
      (validateWorkspacePtyCwd as Mock).mockResolvedValue({ ok: true, cwdReal: '/cwd' });
      (pty.spawn as Mock).mockReturnValue(mockPty);
      (existsSync as Mock).mockReturnValue(true);

      const spawnHandler = handlers.get('workspace-pty-spawn')!;
      const spawnResult = await spawnHandler({}, '/workspace', '/workspace', 80, 24) as { success: true; sessionId: string };

      const resizeHandler = handlers.get('workspace-pty-resize')!;
      await resizeHandler({}, spawnResult.sessionId, 'invalid', undefined);

      expect(mockPty.resize).toHaveBeenCalledWith(80, 24);
    });
  });

  describe('workspace-pty-kill', () => {
    beforeEach(() => {
      registerWorkspacePtyIpc();
    });

    it('returns error for non-existent session', async () => {
      const handler = handlers.get('workspace-pty-kill')!;
      const result = await handler({}, 'non-existent-session');

      expect(result).toEqual({ success: false, error: 'Session not found' });
    });

    it('kills existing session and removes from map', async () => {
      const mockPty = {
        pid: 12345,
        onData: vi.fn(),
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      };
      (validateWorkspacePtyCwd as Mock).mockResolvedValue({ ok: true, cwdReal: '/cwd' });
      (pty.spawn as Mock).mockReturnValue(mockPty);
      (existsSync as Mock).mockReturnValue(true);

      const spawnHandler = handlers.get('workspace-pty-spawn')!;
      const spawnResult = await spawnHandler({}, '/workspace', '/workspace', 80, 24) as { success: true; sessionId: string };

      const killHandler = handlers.get('workspace-pty-kill')!;
      const result = await killHandler({}, spawnResult.sessionId);

      expect(result).toEqual({ success: true });
      expect(mockPty.kill).toHaveBeenCalled();

      const writeResult = await handlers.get('workspace-pty-write')!({}, spawnResult.sessionId, 'data');
      expect(writeResult).toEqual({ success: false, error: 'Session not found' });
    });

    it('still removes session from map even if kill throws', async () => {
      const mockPty = {
        pid: 12345,
        onData: vi.fn(),
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(() => {
          throw new Error('Kill failed');
        }),
      };
      (validateWorkspacePtyCwd as Mock).mockResolvedValue({ ok: true, cwdReal: '/cwd' });
      (pty.spawn as Mock).mockReturnValue(mockPty);
      (existsSync as Mock).mockReturnValue(true);

      const spawnHandler = handlers.get('workspace-pty-spawn')!;
      const spawnResult = await spawnHandler({}, '/workspace', '/workspace', 80, 24) as { success: true; sessionId: string };

      const killHandler = handlers.get('workspace-pty-kill')!;
      const result = await killHandler({}, spawnResult.sessionId);

      expect(result).toMatchObject({ success: false });

      const writeResult = await handlers.get('workspace-pty-write')!({}, spawnResult.sessionId, 'data');
      expect(writeResult).toEqual({ success: false, error: 'Session not found' });
    });
  });

  describe('workspace-pty-kill-all', () => {
    beforeEach(() => {
      registerWorkspacePtyIpc();
    });

    it('kills all active sessions', async () => {
      const mockPty1 = {
        pid: 12345,
        onData: vi.fn(),
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      };
      const mockPty2 = {
        pid: 12346,
        onData: vi.fn(),
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      };
      (validateWorkspacePtyCwd as Mock).mockResolvedValue({ ok: true, cwdReal: '/cwd' });
      (pty.spawn as Mock)
        .mockReturnValueOnce(mockPty1)
        .mockReturnValueOnce(mockPty2);
      (existsSync as Mock).mockReturnValue(true);

      const spawnHandler = handlers.get('workspace-pty-spawn')!;
      const result1 = await spawnHandler({}, '/workspace', '/workspace', 80, 24) as { success: true; sessionId: string };
      const result2 = await spawnHandler({}, '/workspace', '/workspace', 80, 24) as { success: true; sessionId: string };

      const killAllHandler = handlers.get('workspace-pty-kill-all')!;
      const result = await killAllHandler({});

      expect(result).toEqual({ success: true });
      expect(mockPty1.kill).toHaveBeenCalled();
      expect(mockPty2.kill).toHaveBeenCalled();

      const writeResult1 = await handlers.get('workspace-pty-write')!({}, result1.sessionId, 'data');
      const writeResult2 = await handlers.get('workspace-pty-write')!({}, result2.sessionId, 'data');
      expect(writeResult1).toEqual({ success: false, error: 'Session not found' });
      expect(writeResult2).toEqual({ success: false, error: 'Session not found' });
    });
  });

  describe('ANSI color sequences', () => {
    beforeEach(() => {
      registerWorkspacePtyIpc();
    });

    it('preserves ANSI escape sequences in PTY output', async () => {
      let dataCallback: ((data: string) => void) | null = null;
      const mockPty = {
        pid: 12345,
        onData: vi.fn((cb: (data: string) => void) => {
          dataCallback = cb;
        }),
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      };
      (validateWorkspacePtyCwd as Mock).mockResolvedValue({ ok: true, cwdReal: '/cwd' });
      (pty.spawn as Mock).mockReturnValue(mockPty);
      (existsSync as Mock).mockReturnValue(true);

      const handler = handlers.get('workspace-pty-spawn')!;
      const result = await handler({}, '/workspace', '/workspace', 80, 24) as { success: true; sessionId: string };

      const coloredOutput = '\x1b[31mRed text\x1b[0m \x1b[32mGreen text\x1b[0m';
      dataCallback!(coloredOutput);

      expect(mainState.mainWindow?.webContents.send).toHaveBeenCalledWith(
        'workspace-pty-data',
        { sessionId: result.sessionId, data: coloredOutput }
      );
    });

    it('preserves 256-color ANSI sequences', async () => {
      let dataCallback: ((data: string) => void) | null = null;
      const mockPty = {
        pid: 12345,
        onData: vi.fn((cb: (data: string) => void) => {
          dataCallback = cb;
        }),
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      };
      (validateWorkspacePtyCwd as Mock).mockResolvedValue({ ok: true, cwdReal: '/cwd' });
      (pty.spawn as Mock).mockReturnValue(mockPty);
      (existsSync as Mock).mockReturnValue(true);

      const handler = handlers.get('workspace-pty-spawn')!;
      const result = await handler({}, '/workspace', '/workspace', 80, 24) as { success: true; sessionId: string };

      const color256Output = '\x1b[38;5;196mBright red\x1b[0m';
      dataCallback!(color256Output);

      expect(mainState.mainWindow?.webContents.send).toHaveBeenCalledWith(
        'workspace-pty-data',
        { sessionId: result.sessionId, data: color256Output }
      );
    });

    it('preserves true color (24-bit) ANSI sequences', async () => {
      let dataCallback: ((data: string) => void) | null = null;
      const mockPty = {
        pid: 12345,
        onData: vi.fn((cb: (data: string) => void) => {
          dataCallback = cb;
        }),
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      };
      (validateWorkspacePtyCwd as Mock).mockResolvedValue({ ok: true, cwdReal: '/cwd' });
      (pty.spawn as Mock).mockReturnValue(mockPty);
      (existsSync as Mock).mockReturnValue(true);

      const handler = handlers.get('workspace-pty-spawn')!;
      const result = await handler({}, '/workspace', '/workspace', 80, 24) as { success: true; sessionId: string };

      const trueColorOutput = '\x1b[38;2;255;128;0mOrange\x1b[0m';
      dataCallback!(trueColorOutput);

      expect(mainState.mainWindow?.webContents.send).toHaveBeenCalledWith(
        'workspace-pty-data',
        { sessionId: result.sessionId, data: trueColorOutput }
      );
    });
  });
});

describe('security: session isolation', () => {
  let handlers: Map<string, (...args: unknown[]) => Promise<unknown>>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map();
    (ipcMain.handle as Mock).mockImplementation((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, handler);
    });
    registerWorkspacePtyIpc();
  });

  afterEach(() => {
    killAllWorkspacePtySessions();
  });

  it('prevents writing to wrong session', async () => {
    const mockPty1 = {
      pid: 12345,
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
    const mockPty2 = {
      pid: 12346,
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
    (validateWorkspacePtyCwd as Mock).mockResolvedValue({ ok: true, cwdReal: '/cwd' });
    (pty.spawn as Mock)
      .mockReturnValueOnce(mockPty1)
      .mockReturnValueOnce(mockPty2);
    (existsSync as Mock).mockReturnValue(true);

    const spawnHandler = handlers.get('workspace-pty-spawn')!;
    const result1 = await spawnHandler({}, '/workspace', '/workspace', 80, 24) as { success: true; sessionId: string };
    const result2 = await spawnHandler({}, '/workspace', '/workspace', 80, 24) as { success: true; sessionId: string };

    const writeHandler = handlers.get('workspace-pty-write')!;
    await writeHandler({}, result1.sessionId, 'for session 1');
    await writeHandler({}, result2.sessionId, 'for session 2');

    expect(mockPty1.write).toHaveBeenCalledWith('for session 1');
    expect(mockPty1.write).not.toHaveBeenCalledWith('for session 2');
    expect(mockPty2.write).toHaveBeenCalledWith('for session 2');
    expect(mockPty2.write).not.toHaveBeenCalledWith('for session 1');
  });

  it('generates unique session IDs', async () => {
    const mockPty = {
      pid: 12345,
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
    (validateWorkspacePtyCwd as Mock).mockResolvedValue({ ok: true, cwdReal: '/cwd' });
    (pty.spawn as Mock).mockReturnValue(mockPty);
    (existsSync as Mock).mockReturnValue(true);

    const spawnHandler = handlers.get('workspace-pty-spawn')!;
    const results: string[] = [];

    for (let i = 0; i < 10; i++) {
      const result = await spawnHandler({}, '/workspace', '/workspace', 80, 24) as { success: true; sessionId: string };
      results.push(result.sessionId);
    }

    const uniqueIds = new Set(results);
    expect(uniqueIds.size).toBe(10);
  });
});
