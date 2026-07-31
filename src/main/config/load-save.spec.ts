import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AppConfig } from '../../shared';
import { createDefaultConfig } from './defaults';

vi.mock('../paths', () => ({
  getConfigPath: () => join(process.env.CLARA_TEST_CONFIG_DIR ?? '', 'config.json'),
}));

import { loadConfig, mergeSettingsConfigSave, updateConfig } from './load-save';

function sampleConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = createDefaultConfig();
  return {
    ...base,
    workspaces: [
      {
        id: 'ws-a',
        name: 'A',
        path: '/tmp/a',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    currentWorkspaceId: 'ws-a',
    lastActiveConversationByWorkspaceId: { 'ws-a': 'conv-a' },
    workspaceMonacoScrollByWorkspaceId: {
      'ws-a': { 'src/a.ts': { scrollTop: 120, scrollLeft: 0 } },
    },
    chatFontSizeRem: 1.1,
    ...overrides,
  };
}

describe('mergeSettingsConfigSave', () => {
  it('preserves workspace registry fields from disk', () => {
    const disk = sampleConfig();
    const client = sampleConfig({
      workspaces: [],
      currentWorkspaceId: null,
      lastActiveConversationByWorkspaceId: {},
      chatFontSizeRem: 1.4,
    });

    const merged = mergeSettingsConfigSave(disk, client);
    expect(merged.workspaces).toEqual(disk.workspaces);
    expect(merged.currentWorkspaceId).toBe('ws-a');
    expect(merged.lastActiveConversationByWorkspaceId).toEqual({ 'ws-a': 'conv-a' });
    expect(merged.workspaceMonacoScrollByWorkspaceId).toEqual({
      'ws-a': { 'src/a.ts': { scrollTop: 120, scrollLeft: 0 } },
    });
    expect(merged.chatFontSizeRem).toBe(1.4);
  });
});

describe('updateConfig serialization', () => {
  let tempDir = '';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'nemo-config-test-'));
    process.env.CLARA_TEST_CONFIG_DIR = tempDir;
    writeFileSync(join(tempDir, 'config.json'), JSON.stringify(sampleConfig(), null, 2), 'utf-8');
  });

  afterEach(() => {
    delete process.env.CLARA_TEST_CONFIG_DIR;
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('serializes concurrent mutations without losing workspace additions', async () => {
    await Promise.all([
      updateConfig((cfg) => {
        cfg.workspaces.push({
          id: 'ws-b',
          name: 'B',
          path: '/tmp/b',
          createdAt: '2026-01-02T00:00:00.000Z',
        });
      }),
      updateConfig((cfg) => {
        cfg.lastActiveConversationByWorkspaceId = {
          ...(cfg.lastActiveConversationByWorkspaceId ?? {}),
          'ws-a': 'conv-updated',
        };
      }),
      updateConfig((cfg) => {
        cfg.chatFontSizeRem = 1.25;
      }),
    ]);

    const saved = JSON.parse(readFileSync(join(tempDir, 'config.json'), 'utf-8')) as AppConfig;
    expect(saved.workspaces.map((w) => w.id).sort()).toEqual(['ws-a', 'ws-b']);
    expect(saved.lastActiveConversationByWorkspaceId?.['ws-a']).toBe('conv-updated');
    expect(saved.chatFontSizeRem).toBe(1.25);
    expect(existsSync(join(tempDir, 'config.json.bak'))).toBe(true);
  });

  it('loadConfig returns persisted config without resetting on retryable read races', async () => {
    const loaded = await loadConfig();
    expect(loaded.workspaces).toHaveLength(1);
    expect(loaded.workspaces[0]?.id).toBe('ws-a');
  });
});
