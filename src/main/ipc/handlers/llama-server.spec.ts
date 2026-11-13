import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const mainSender = { id: 'main' };
  const settingsSender = { id: 'settings' };
  return {
    handlers: new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>(),
    mainSender,
    settingsSender,
    start: vi.fn(),
    stop: vi.fn(),
    status: vi.fn(),
    consoles: vi.fn(),
    healthSender: { id: 'health' },
    ping: vi.fn(),
    syncOverrides: vi.fn(),
    loadConfig: vi.fn(),
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      mocks.handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../state', () => ({
  mainState: {
    mainWindow: { isDestroyed: () => false, webContents: mocks.mainSender },
    settingsWindow: { isDestroyed: () => false, webContents: mocks.settingsSender },
    healthWindow: { isDestroyed: () => false, webContents: mocks.healthSender },
  },
}));

vi.mock('../../llama-server-manager', () => ({
  getManagedChatOpenAiBaseUrl: vi.fn(),
  getManagedLlamaConsoles: mocks.consoles,
  getManagedLlamaLaunchedCommand: vi.fn(),
  getManagedLlamaStatus: mocks.status,
  startManagedLlamaServers: mocks.start,
  stopManagedLlamaServers: mocks.stop,
  syncWithManagedLlamaOverrides: mocks.syncOverrides,
}));
vi.mock('../../config/load-save', () => ({ loadConfig: mocks.loadConfig }));
vi.mock('../../llm-source-ping', () => ({ pingLlmSource: mocks.ping }));
vi.mock('../../chat-template-reasoning-cache', () => ({
  getCachedChatTemplateReasoning: vi.fn(),
  getCachedLlamaServerNctx: vi.fn(),
}));
vi.mock('../../llama-server-flag-catalog', () => ({ getLlamaServerFlagCatalog: vi.fn() }));
vi.mock('../../utils/gguf-profile', () => ({ readGgufProfile: vi.fn() }));
vi.mock('../../utils/gguf-size', () => ({ ggufBytesOnDisk: vi.fn() }));
vi.mock('../../utils/gpu-vram-usage', () => ({ sampleGpuVramUsage: vi.fn() }));
vi.mock('../../openai-compatible-models', () => ({ fetchOpenAiCompatibleModelIds: vi.fn() }));
vi.mock('../../openrouter-reasoning', () => ({
  findOpenRouterConnection: vi.fn(),
  refreshOpenRouterReasoningForConnection: vi.fn(),
}));
vi.mock('../../anthropic-models', () => ({
  findAnthropicConnection: vi.fn(),
  refreshAnthropicReasoningForConnection: vi.fn(),
}));
vi.mock('../../lm-studio-runtime', () => ({
  findLmStudioConnection: vi.fn(),
  refreshLmStudioReasoningForConnection: vi.fn(),
}));
vi.mock('../../python/http-client', () => ({ pythonControlFetch: vi.fn() }));

import { registerLlamaServerIpc } from './llama-server';

const SAVED = { source: 'saved on disk' };
const SENT = { source: 'sent by the window' };

function invoke(channel: string, sender: unknown, payload: unknown = { modelId: ' m1 ', config: SENT }): Promise<unknown> {
  return mocks.handlers.get(channel)!({ sender }, payload);
}

describe('llama server IPC senders', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    for (const fn of [mocks.start, mocks.stop, mocks.status, mocks.ping, mocks.syncOverrides, mocks.loadConfig]) {
      fn.mockReset();
    }
    mocks.loadConfig.mockResolvedValue(SAVED);
    mocks.start.mockResolvedValue({ ok: true });
    mocks.status.mockResolvedValue({ ok: true, running: false });
    mocks.ping.mockResolvedValue({ ok: true });
    registerLlamaServerIpc();
  });

  it('acts on the config the main window sends', async () => {
    await invoke('llama-server:start', mocks.mainSender);
    await invoke('llama-server:status', mocks.mainSender);
    await invoke('llm-source:ping', mocks.mainSender);
    expect(mocks.start).toHaveBeenCalledWith('m1', SENT);
    expect(mocks.status).toHaveBeenCalledWith('m1', SENT);
    expect(mocks.ping).toHaveBeenCalledWith('m1', SENT);
    expect(mocks.loadConfig).not.toHaveBeenCalled();
  });

  it('gives the Settings window the saved config, whatever it sends', async () => {
    await invoke('llama-server:start', mocks.settingsSender);
    await invoke('llama-server:status', mocks.settingsSender);
    await invoke('llm-source:ping', mocks.settingsSender);
    expect(mocks.start).toHaveBeenCalledWith('m1', SAVED);
    expect(mocks.status).toHaveBeenCalledWith('m1', SAVED);
    expect(mocks.ping).toHaveBeenCalledWith('m1', SAVED);
  });

  it('lets the Settings window stop a server', async () => {
    expect(await invoke('llama-server:stop', mocks.settingsSender)).toEqual({ ok: true });
    expect(mocks.stop).toHaveBeenCalledWith('m1');
    expect(mocks.syncOverrides).toHaveBeenCalledOnce();
  });

  it('gives every app window the consoles, and nobody else', async () => {
    const snapshot = [{ modelId: 'm1', phase: 'running', streams: [{ stream: 'chat', text: 'ready' }] }];
    mocks.consoles.mockReturnValue(snapshot);
    for (const sender of [mocks.mainSender, mocks.settingsSender, mocks.healthSender]) {
      expect(await invoke('llama-server:consoles', sender)).toEqual(snapshot);
    }
    expect(await invoke('llama-server:consoles', { id: 'stranger' })).toEqual([]);
  });

  it('keeps the Health window from starting or stopping a server', async () => {
    for (const channel of ['llama-server:start', 'llama-server:stop', 'llama-server:status', 'llm-source:ping']) {
      expect(await invoke(channel, mocks.healthSender)).toEqual({ ok: false, error: 'Untrusted IPC sender' });
    }
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
  });

  it('refuses any other sender', async () => {
    const stranger = { id: 'an unknown window' };
    for (const channel of ['llama-server:start', 'llama-server:stop', 'llama-server:status', 'llm-source:ping']) {
      expect(await invoke(channel, stranger)).toEqual({ ok: false, error: 'Untrusted IPC sender' });
    }
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.ping).not.toHaveBeenCalled();
  });
});
