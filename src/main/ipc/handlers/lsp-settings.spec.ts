import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handleHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  loadConfig: vi.fn(),
  assertTrustedAppRenderer: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handleHandlers.set(channel, handler);
    }),
  },
}));

vi.mock('../assert-trusted-renderer', () => ({ assertTrustedAppRenderer: mocks.assertTrustedAppRenderer }));
vi.mock('../../config/load-save', () => ({ loadConfig: mocks.loadConfig }));

import { findPythonProjectConfig, registerLspSettingsIpc } from './lsp-settings';

describe('findPythonProjectConfig', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'clara-pyconfig-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns null with no config and for an empty path', async () => {
    expect(await findPythonProjectConfig(root)).toBeNull();
    expect(await findPythonProjectConfig('')).toBeNull();
  });

  it('ignores a pyproject.toml without a pyright table', async () => {
    writeFileSync(path.join(root, 'pyproject.toml'), '[project]\nname = "x"\n\n[tool.ruff]\n');
    expect(await findPythonProjectConfig(root)).toBeNull();
  });

  it('finds the pyproject table', async () => {
    writeFileSync(path.join(root, 'pyproject.toml'), '[project]\nname = "x"\n\n[tool.basedpyright]\n');
    expect(await findPythonProjectConfig(root)).toEqual({ file: 'pyproject.toml', section: 'tool.basedpyright' });
  });

  it('prefers pyrightconfig.json, as basedpyright does', async () => {
    writeFileSync(path.join(root, 'pyproject.toml'), '[tool.pyright]\n');
    writeFileSync(path.join(root, 'pyrightconfig.json'), '{}');
    expect(await findPythonProjectConfig(root)).toEqual({ file: 'pyrightconfig.json', section: '' });
  });
});

describe('lsp:python-project-config', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'clara-pyconfig-ipc-'));
    mocks.handleHandlers.clear();
    mocks.assertTrustedAppRenderer.mockReset();
    registerLspSettingsIpc();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const invoke = () => mocks.handleHandlers.get('lsp:python-project-config')!({});

  it('checks the current workspace', async () => {
    writeFileSync(path.join(root, 'pyrightconfig.json'), '{}');
    mocks.loadConfig.mockResolvedValue({
      currentWorkspaceId: 'b',
      workspaces: [
        { id: 'a', path: os.tmpdir() },
        { id: 'b', path: root },
      ],
    });
    expect(await invoke()).toEqual({
      ok: true,
      workspacePath: root,
      config: { file: 'pyrightconfig.json', section: '' },
    });
  });

  it('reports no workspace as no config', async () => {
    mocks.loadConfig.mockResolvedValue({ currentWorkspaceId: '', workspaces: [] });
    expect(await invoke()).toEqual({ ok: true, workspacePath: '', config: null });
  });

  it('refuses an untrusted sender', async () => {
    mocks.loadConfig.mockClear();
    mocks.assertTrustedAppRenderer.mockImplementation(() => {
      throw new Error('nope');
    });
    expect(await invoke()).toMatchObject({ ok: false, config: null });
    expect(mocks.loadConfig).not.toHaveBeenCalled();
  });
});
