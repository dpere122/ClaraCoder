import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compactFavoriteOrders } from '../../shared';
import type { AppConfig } from '../../shared';

vi.mock('../config/load-save', () => ({
  loadConfig: vi.fn(),
  updateConfig: vi.fn(),
}));
vi.mock('../conversations-db', () => ({
  deleteConversationsByWorkspaceId: vi.fn(() => []),
  listConversationIdsByWorkspaceId: vi.fn(() => []),
  listDistinctConversationWorkspaceIds: vi.fn(() => []),
}));
vi.mock('../ipc/handlers/chat-stream-state', () => ({
  abortChatStream: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../python/http-client', () => ({
  pythonControlFetch: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../paths', () => ({
  getWorkspaceDir: (id: string) => join(tmpdir(), 'clara-lost-ws', id),
  getWorkspaceSemanticIndexPersistDir: (id: string) => join(tmpdir(), 'clara-lost-idx', id),
  getWorkspacesDir: () => join(tmpdir(), 'clara-lost-workspaces'),
}));

import { loadConfig, updateConfig } from '../config/load-save';
import { listDistinctConversationWorkspaceIds } from '../conversations-db';
import { classifyWorkspaceRoot, dropWorkspaceFromConfig, reconcileLostWorkspaces } from './lost-workspace';

function sampleConfig(): AppConfig {
  return {
    currentWorkspaceId: 'ws-a',
    workspaces: [
      {
        id: 'ws-a',
        name: 'A',
        path: '/tmp/a',
        createdAt: '2026-01-01T00:00:00.000Z',
        favorite: true,
        favoriteOrder: 0,
      },
      {
        id: 'ws-b',
        name: 'B',
        path: '/tmp/b',
        createdAt: '2026-01-01T00:00:00.000Z',
        favorite: true,
        favoriteOrder: 1,
      },
    ],
    themeId: 'clara-dark',
    activeLlmModelId: 'm',
    llmProviders: [],
    audioTranscription: {} as AppConfig['audioTranscription'],
    workspaceTools: {} as AppConfig['workspaceTools'],
    contextCompression: {} as AppConfig['contextCompression'],
    healthMonitor: {} as AppConfig['healthMonitor'],
    modelManager: {} as AppConfig['modelManager'],
    lastActiveConversationByWorkspaceId: { 'ws-a': 'conv-a', 'ws-b': 'conv-b' },
    workspaceOpenTabsByWorkspaceId: {
      'ws-a': { tabs: [{ relativePath: 'a.ts', outsideWorkspace: false }], activeTabId: 'file:rel:a.ts' },
    },
    workspaceMonacoScrollByWorkspaceId: {
      'ws-a': { 'a.ts': { scrollTop: 1, scrollLeft: 0 } },
    },
  };
}

describe('classifyWorkspaceRoot', () => {
  let root = '';

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = '';
    }
  });

  it('returns ok for an existing directory', async () => {
    root = mkdtempSync(join(tmpdir(), 'clara-ws-ok-'));
    await expect(classifyWorkspaceRoot(root)).resolves.toBe('ok');
  });

  it('returns missing for a path that does not exist', async () => {
    await expect(classifyWorkspaceRoot(join(tmpdir(), `clara-ws-gone-${Date.now()}`))).resolves.toBe(
      'missing',
    );
  });

  it('returns missing when the path is a file, not a directory', async () => {
    root = mkdtempSync(join(tmpdir(), 'clara-ws-file-'));
    const filePath = join(root, 'not-a-dir');
    writeFileSync(filePath, 'x');
    await expect(classifyWorkspaceRoot(filePath)).resolves.toBe('missing');
  });

  it('returns missing for an empty path', async () => {
    await expect(classifyWorkspaceRoot('')).resolves.toBe('missing');
    await expect(classifyWorkspaceRoot('   ')).resolves.toBe('missing');
  });
});

describe('dropWorkspaceFromConfig', () => {
  it('removes the workspace, client maps, and last-active conversation', () => {
    const cfg = sampleConfig();
    expect(dropWorkspaceFromConfig(cfg, 'ws-a')).toBe(true);
    expect(cfg.workspaces.map((workspace) => workspace.id)).toEqual(['ws-b']);
    expect(cfg.currentWorkspaceId).toBe('ws-b');
    expect(cfg.lastActiveConversationByWorkspaceId).toEqual({ 'ws-b': 'conv-b' });
    expect(cfg.workspaceOpenTabsByWorkspaceId).toEqual({});
    expect(cfg.workspaceMonacoScrollByWorkspaceId).toEqual({});
    expect(cfg.workspaces[0]?.favoriteOrder).toBe(0);
    expect(compactFavoriteOrders(cfg.workspaces)).toEqual(cfg.workspaces);
  });

  it('is a no-op for unknown ids besides pruning leftover client maps', () => {
    const cfg = sampleConfig();
    cfg.lastActiveConversationByWorkspaceId = { ...(cfg.lastActiveConversationByWorkspaceId ?? {}), 'ws-x': 'conv-x' };
    expect(dropWorkspaceFromConfig(cfg, 'ws-x')).toBe(false);
    expect(cfg.workspaces).toHaveLength(2);
    expect(cfg.currentWorkspaceId).toBe('ws-a');
    expect(cfg.lastActiveConversationByWorkspaceId?.['ws-x']).toBeUndefined();
  });
});

describe('reconcileLostWorkspaces', () => {
  let keepDir = '';

  afterEach(() => {
    if (keepDir) {
      rmSync(keepDir, { recursive: true, force: true });
      keepDir = '';
    }
  });

  it('drops only workspaces whose folders are gone', async () => {
    keepDir = mkdtempSync(join(tmpdir(), 'clara-ws-keep-'));
    const cfg = sampleConfig();
    cfg.workspaces[0] = { ...cfg.workspaces[0]!, path: keepDir };
    cfg.workspaces[1] = {
      ...cfg.workspaces[1]!,
      path: join(tmpdir(), `clara-ws-missing-${Date.now()}`),
    };

    vi.mocked(loadConfig).mockResolvedValue(cfg);
    vi.mocked(updateConfig).mockImplementation(async (mutator) => {
      await mutator(cfg);
      return cfg;
    });
    vi.mocked(listDistinctConversationWorkspaceIds).mockReturnValue([]);

    const result = await reconcileLostWorkspaces();
    expect(result.removedIds).toEqual(['ws-b']);
    expect(result.config.workspaces.map((workspace) => workspace.id)).toEqual(['ws-a']);
    expect(result.currentWorkspaceChanged).toBe(false);
  });
});
