/**
 * Lifecycle races: overlapping start, stop during health wait, spawn errors, embed crash.
 */
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as path from 'path';
import * as os from 'os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../shared';

const { spawnMock, spawnSyncMock, sendMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  spawnSyncMock: vi.fn(() => ({ status: 0 })),
  sendMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

vi.mock('./python/workspace-sync', () => ({ syncRuntimeConfigToPython: vi.fn(async () => undefined) }));

vi.mock('./runtime/dependency-manager', () => ({
  rewriteManagedLlamaCommand: (command: string, managedBinary: string | null) => {
    if (!managedBinary) {
      return command;
    }
    const trimmed = command.trim();
    if (!trimmed) {
      return command;
    }
    const m = /^(["']?)llama-server(?:\.exe)?\1(\s|$)/i.exec(trimmed);
    if (!m) {
      return command;
    }
    const rest = trimmed.slice(m[0].length);
    return `"${managedBinary}"${rest ? (rest.startsWith(' ') ? rest : ` ${rest}`) : ''}`;
  },
}));

let tempBinDir = '';
let managedBin = '';

vi.mock('./paths', () => ({
  getRuntimeBinDir: () => tempBinDir,
  getManagedLlamaServerPath: () => managedBin || null,
}));

vi.mock('./config/load-save', () => ({
  loadConfigSync: () => ({
    modelManager: { huggingFaceToken: '', customModelsDir: '' },
    llmProviders: [],
  }),
}));

vi.mock('./state', () => ({
  mainState: {
    mainWindow: {
      webContents: { send: sendMock },
    },
  },
}));

vi.mock('./log-ingest', () => ({ ingestElectronLog: vi.fn() }));

vi.mock('electron', () => ({
  app: {
    getPath: () => os.tmpdir(),
    isPackaged: false,
    setPath: () => undefined,
  },
}));

vi.mock('net', () => {
  let port = 41000;
  return {
    createServer: () => {
      const assigned = ++port;
      return {
        listen(_p: unknown, _h: unknown, cb?: () => void) {
          const fn = typeof _h === 'function' ? _h : cb;
          if (typeof fn === 'function') {
            queueMicrotask(fn);
          }
        },
        address: () => ({ port: assigned }),
        close: (cb?: () => void) => {
          cb?.();
        },
        on() {
          return this;
        },
      };
    },
  };
});

import {
  startManagedLlamaServers,
  stopManagedLlamaServers,
  stopAllManagedLlamaServers,
  getLlamaManagedRuntimeOverrides,
  isManagedLlamaRunningForActivePreset,
} from './llama-server-manager';
import { ingestElectronLog } from './log-ingest';

type FakeProc = EventEmitter & {
  pid: number;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: null;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
};

function fakeProc(pid: number): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.pid = pid;
  proc.killed = false;
  proc.kill = vi.fn();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = null;
  proc.exitCode = null;
  proc.signalCode = null;
  return proc;
}

function makeConfig(opts?: { embed?: boolean }): AppConfig {
  const binName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  return {
    activeLlmModelId: 'm1',
    llmProviders: [
      {
        id: 'p1',
        name: 'local',
        provider: 'llamacpp',
        baseUrl: 'http://127.0.0.1:8080/v1',
        apiKey: '',
        models: [
          {
            id: 'm1',
            name: 'model',
            model: 'm',
            contextWindowTokens: 8192,
            thinkingMode: 'off',
            samplingPreset: 'default',
            llamaCppManaged: {
              chatRunCommand: `${binName} --host 127.0.0.1 --port {{PORT}} -m /m.gguf`,
              embeddingRunCommand: opts?.embed
                ? `${binName} --host 127.0.0.1 --port {{PORT}} -m /e.gguf --embedding`
                : '',
            },
          },
        ],
      },
    ],
    modelManager: { huggingFaceToken: '', customModelsDir: '' },
  } as AppConfig;
}

describe('managed llama-server lifecycle', () => {
  const procs: FakeProc[] = [];

  beforeEach(() => {
    procs.length = 0;
    sendMock.mockReset();
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: 0 });
    spawnMock.mockReset();
    vi.mocked(ingestElectronLog).mockReset();
    spawnMock.mockImplementation(() => {
      const p = fakeProc(2000 + procs.length);
      procs.push(p);
      return p;
    });

    tempBinDir = mkdtempSync(path.join(os.tmpdir(), 'clara-llama-life-'));
    mkdirSync(tempBinDir, { recursive: true });
    const binName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
    managedBin = path.join(tempBinDir, binName);
    writeFileSync(managedBin, '#!/bin/sh\n');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('not listening');
      }),
    );
  });

  afterEach(() => {
    stopAllManagedLlamaServers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(tempBinDir, { recursive: true, force: true });
  });

  it('rejects a second start while the first is still in flight', async () => {
    const cfg = makeConfig();
    const first = startManagedLlamaServers('m1', cfg);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    const second = await startManagedLlamaServers('m1', cfg);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toMatch(/already running/i);
    }
    stopManagedLlamaServers('m1');
    const firstResult = await first;
    expect(firstResult.ok).toBe(false);
  });

  it('stop during health wait kills the process and does not emit running', async () => {
    const cfg = makeConfig();
    const startP = startManagedLlamaServers('m1', cfg);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    expect(procs[0]).toBeDefined();
    stopManagedLlamaServers('m1');
    const result = await startP;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/stopped/i);
    }
    const runningEmits = sendMock.mock.calls.filter(
      (c) => c[0] === 'llama-server-lifecycle' && (c[1] as { phase?: string })?.phase === 'running',
    );
    expect(runningEmits).toHaveLength(0);
    expect(isManagedLlamaRunningForActivePreset(cfg)).toBe(false);
  });

  it('fails fast when spawn emits error', async () => {
    spawnMock.mockImplementation(() => {
      const p = fakeProc(3001);
      procs.push(p);
      queueMicrotask(() => p.emit('error', new Error('ENOENT')));
      return p;
    });
    const cfg = makeConfig();
    const result = await startManagedLlamaServers('m1', cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/failed to start/i);
    }
  }, 10_000);

  it('clears embed after a post-ready crash and leaves chat running', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true })),
    );
    const cfg = makeConfig({ embed: true });
    const result = await startManagedLlamaServers('m1', cfg);
    expect(result.ok).toBe(true);
    expect(procs.length).toBe(2);
    const ovReady = getLlamaManagedRuntimeOverrides(cfg);
    expect(ovReady.m1.baseUrl).toMatch(/127\.0\.0\.1:\d+\/v1/);
    expect(ovReady.m1.embeddingsBaseUrl).toMatch(/127\.0\.0\.1:\d+\/v1/);

    const embed = procs[1];
    embed.exitCode = 1;
    embed.emit('exit', 1, null);
    await Promise.resolve();

    const ov = getLlamaManagedRuntimeOverrides(cfg);
    expect(ov.m1.baseUrl).toMatch(/127\.0\.0\.1:\d+\/v1/);
    expect(ov.m1.embeddingsBaseUrl).toBe('');
    expect(isManagedLlamaRunningForActivePreset(cfg)).toBe(true);
  });

  it('logs unexpected chat exit and stops the managed pair', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true })),
    );
    const cfg = makeConfig();
    const result = await startManagedLlamaServers('m1', cfg);
    expect(result.ok).toBe(true);
    vi.mocked(ingestElectronLog).mockClear();

    const chat = procs[0];
    chat.exitCode = 1;
    chat.emit('exit', 1, null);
    await Promise.resolve();

    expect(isManagedLlamaRunningForActivePreset(cfg)).toBe(false);
    const messages = vi.mocked(ingestElectronLog).mock.calls.map((c) => String(c[2]));
    expect(messages.some((m) => /chat llama-server process exited/.test(m) && /unexpected=true/.test(m))).toBe(
      true,
    );
    expect(messages.some((m) => /stopped managed llama-server/.test(m))).toBe(true);
  });

  it('logs embed process exit without stopping chat', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true })),
    );
    const cfg = makeConfig({ embed: true });
    const result = await startManagedLlamaServers('m1', cfg);
    expect(result.ok).toBe(true);
    vi.mocked(ingestElectronLog).mockClear();

    const embed = procs[1];
    embed.exitCode = 1;
    embed.emit('exit', 1, null);
    await Promise.resolve();

    expect(isManagedLlamaRunningForActivePreset(cfg)).toBe(true);
    const messages = vi.mocked(ingestElectronLog).mock.calls.map((c) => String(c[2]));
    expect(messages.some((m) => /embed llama-server process exited/.test(m) && /unexpected=true/.test(m))).toBe(
      true,
    );
  });

  it('forwards llama-server stderr lines into app logs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true })),
    );
    const cfg = makeConfig();
    const result = await startManagedLlamaServers('m1', cfg);
    expect(result.ok).toBe(true);
    vi.mocked(ingestElectronLog).mockClear();

    procs[0].stderr.emit('data', Buffer.from('slot 0 is busy processing\n'));
    await Promise.resolve();

    expect(vi.mocked(ingestElectronLog)).toHaveBeenCalledWith(
      'INFO',
      'clara.electron.llama',
      expect.stringMatching(/chat stderr: slot 0 is busy processing/),
      'electron',
    );
  });

  it('logs spawn errors to the llama logger', async () => {
    spawnMock.mockImplementation(() => {
      const p = fakeProc(3001);
      procs.push(p);
      queueMicrotask(() => p.emit('error', new Error('ENOENT')));
      return p;
    });
    const cfg = makeConfig();
    await startManagedLlamaServers('m1', cfg);
    const messages = vi.mocked(ingestElectronLog).mock.calls.map((c) => String(c[2]));
    expect(messages.some((m) => /chat llama-server spawn error/.test(m) && /ENOENT/.test(m))).toBe(true);
  });

  it('does not require a bundled chat template for the gemma preset', async () => {
    const cfg = makeConfig();
    cfg.llmProviders[0].models[0].optimizationPreset = 'gemma';
    const startP = startManagedLlamaServers('m1', cfg);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    stopManagedLlamaServers('m1');
    await startP;
  });

  it('fails start when --chat-template-file points at a missing file', async () => {
    const cfg = makeConfig();
    const managed = cfg.llmProviders[0].models[0].llamaCppManaged!;
    const missing = path.join(tempBinDir, 'missing.jinja');
    managed.chatRunCommand = `${managed.chatRunCommand} --chat-template-file ${missing}`;
    const result = await startManagedLlamaServers('m1', cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Chat template file was not found/i);
    }
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('injects --no-webui and -np 1 when the saved command omits them', async () => {
    const cfg = makeConfig();
    const startP = startManagedLlamaServers('m1', cfg);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args).toContain('--no-webui');
    const npAt = args.indexOf('-np');
    expect(npAt).toBeGreaterThanOrEqual(0);
    expect(args[npAt + 1]).toBe('1');
    stopManagedLlamaServers('m1');
    await startP;
  });

  it('injects --reasoning-format none for the gemma preset so thought streams in content', async () => {
    const cfg = makeConfig();
    cfg.llmProviders[0].models[0].optimizationPreset = 'gemma';
    const startP = startManagedLlamaServers('m1', cfg);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    const args = spawnMock.mock.calls[0]?.[1] as string[];
    const fmtAt = args.indexOf('--reasoning-format');
    expect(fmtAt).toBeGreaterThanOrEqual(0);
    expect(args[fmtAt + 1]).toBe('none');
    stopManagedLlamaServers('m1');
    await startP;
  });

  it('does not inject --reasoning-format for a non-gemma preset', async () => {
    const cfg = makeConfig();
    const startP = startManagedLlamaServers('m1', cfg);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args).not.toContain('--reasoning-format');
    stopManagedLlamaServers('m1');
    await startP;
  });
});
