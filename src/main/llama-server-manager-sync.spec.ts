/**
 * Runtime sync after managed llama-server start/stop must post the config on disk, not a
 * snapshot from when Start was clicked (which would revert later MCP trust or workspace changes).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppConfig } from '../shared';

vi.mock('./python/workspace-sync', () => ({ syncRuntimeConfigToPython: vi.fn(async () => undefined) }));
vi.mock('./runtime/dependency-manager', () => ({ rewriteManagedLlamaCommand: vi.fn() }));
vi.mock('./log-ingest', () => ({ ingestElectronLog: vi.fn() }));

const loadConfigSync = vi.fn<() => AppConfig>();
vi.mock('./config/load-save', async () => {
  const actual = await vi.importActual('./config/load-save');
  return { ...actual, loadConfigSync: () => loadConfigSync() };
});

import { syncWithManagedLlamaOverrides } from './llama-server-manager';
import { syncRuntimeConfigToPython } from './python/workspace-sync';

function configWithTrust(trust: 'ask' | 'allow-all'): AppConfig {
  return {
    llmProviders: [],
    modelManager: { huggingFaceToken: '', customModelsDir: '' },
    mcpServers: [{ id: 'srv', trust }],
  } as unknown as AppConfig;
}

describe('syncWithManagedLlamaOverrides', () => {
  beforeEach(() => {
    vi.mocked(syncRuntimeConfigToPython).mockClear();
    loadConfigSync.mockReset();
  });

  it('posts the config on disk at sync time', async () => {
    // Start clicked while the server was allow-all; trust revoked before the start finished.
    loadConfigSync.mockReturnValue(configWithTrust('ask'));
    await syncWithManagedLlamaOverrides();
    const posted = vi.mocked(syncRuntimeConfigToPython).mock.calls[0]?.[0];
    expect(posted?.mcpServers[0]?.trust).toBe('ask');
  });

  it('skips the sync instead of throwing when the config cannot be read', async () => {
    loadConfigSync.mockImplementation(() => {
      throw new Error('Config file is corrupt and no valid backup is available.');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(syncWithManagedLlamaOverrides()).resolves.toBeUndefined();
    expect(syncRuntimeConfigToPython).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
