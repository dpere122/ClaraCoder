import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path = require('path');
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<Record<string, unknown>>>(),
  stubDir: '',
}));

vi.mock('electron', () => ({
  dialog: {},
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<Record<string, unknown>>) => {
      mocks.handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../assert-trusted-renderer', () => ({ assertTrustedMainRenderer: vi.fn() }));
vi.mock('../../config/load-save', () => ({ loadConfig: vi.fn(async () => ({ workspaces: [] })) }));
vi.mock('../../state', () => ({ mainState: { mainWindow: null } }));
vi.mock('../../workspace/emit-files-changed', () => ({ emitWorkspaceFilesChanged: vi.fn() }));
vi.mock('../../paths', () => ({
  getEditorDetachedSnapshotsDir: () => path.join(mocks.stubDir, 'snapshots'),
  getGdlsStubCacheDir: () => mocks.stubDir,
}));

import { registerWorkspaceEditorSnapshotIpc } from './workspace-editor-snapshot';

describe('engine API pages', () => {
  let root: string;
  let page: string;
  const invoke = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!({}, ...args);

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'clara-snapshot-'));
    mocks.stubDir = path.join(root, 'stubs');
    mkdirSync(path.join(mocks.stubDir, 'v1'), { recursive: true });
    page = path.join(mocks.stubDir, 'v1', 'Node2D.gd');
    registerWorkspaceEditorSnapshotIpc();
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    writeFileSync(page, 'class_name Node2D');
  });

  it('can be read, and say they are read-only', async () => {
    expect(await invoke('read-absolute-file', page)).toMatchObject({
      ok: true,
      content: 'class_name Node2D',
      readOnly: true,
    });
  });

  it('cannot be written', async () => {
    expect(await invoke('write-absolute-file', page, 'overwritten')).toMatchObject({ ok: false });
    expect(readFileSync(page, 'utf8')).toBe('class_name Node2D');
  });

  it('do not open up the rest of the runtime directory', async () => {
    const secret = path.join(root, 'secret.txt');
    writeFileSync(secret, 'secret');
    expect(await invoke('read-absolute-file', secret)).toMatchObject({ ok: false });
    expect(await invoke('read-absolute-file', path.join(mocks.stubDir, '..', 'secret.txt'))).toMatchObject({ ok: false });
    expect(await invoke('write-absolute-file', secret, 'x')).toMatchObject({ ok: false });
  });
});
