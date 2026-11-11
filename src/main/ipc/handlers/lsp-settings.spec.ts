import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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

import { checkJavaJdks, findPythonProjectConfig, registerLspSettingsIpc } from './lsp-settings';

const JAVA = process.platform === 'win32' ? 'java.exe' : 'java';

describe('checkJavaJdks', () => {
  let root: string;
  let jdk: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'clara-jdks-'));
    jdk = path.join(root, 'jdk 21');
    mkdirSync(path.join(jdk, 'bin'), { recursive: true });
    writeFileSync(path.join(jdk, 'bin', JAVA), '');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('names the missing Java executable for each folder that is not a JDK', async () => {
    const notJdk = path.join(root, 'empty');
    mkdirSync(path.join(notJdk, 'bin', JAVA), { recursive: true }); // a folder named java isn't one
    expect(await checkJavaJdks(path.join(root, 'nope'), [jdk, notJdk, ''])).toEqual({
      jdkHome: path.join(root, 'nope', 'bin', JAVA),
      runtimes: [null, path.join(notJdk, 'bin', JAVA), null],
    });
  });

  it('leaves an empty JDK folder alone, since the backend then looks at JAVA_HOME and PATH', async () => {
    expect(await checkJavaJdks('  ', [])).toEqual({ jdkHome: null, runtimes: [] });
    expect(await checkJavaJdks(jdk, [])).toEqual({ jdkHome: null, runtimes: [] });
  });

  it('expands ~ in JDK folder only, as the backend does', async () => {
    const home = path.relative(os.homedir(), jdk);
    if (home.startsWith('..') || path.isAbsolute(home)) {
      return; // the temp dir isn't under the home folder here
    }
    const tilde = `~/${home.split(path.sep).join('/')}`;
    const check = await checkJavaJdks(tilde, [tilde]);
    expect(check.jdkHome).toBeNull();
    expect(check.runtimes[0]).toBe(path.join(tilde, 'bin', JAVA));
    expect((await checkJavaJdks('~no-such-user/jdk', [])).jdkHome).toBe(path.join('~no-such-user/jdk', 'bin', JAVA));
  });
});

describe('lsp:java-check-jdks', () => {
  beforeEach(() => {
    mocks.handleHandlers.clear();
    mocks.assertTrustedAppRenderer.mockReset();
    registerLspSettingsIpc();
  });

  const invoke = (...args: unknown[]) => mocks.handleHandlers.get('lsp:java-check-jdks')!({}, ...args);

  it('checks the folders it is given', async () => {
    const missing = path.join(os.tmpdir(), 'clara-no-jdk-here');
    expect(await invoke(missing, [missing])).toEqual({
      ok: true,
      check: { jdkHome: path.join(missing, 'bin', JAVA), runtimes: [path.join(missing, 'bin', JAVA)] },
    });
  });

  it('refuses malformed or oversized requests', async () => {
    expect(await invoke(1, [])).toMatchObject({ ok: false });
    expect(await invoke('', 'C:/jdk')).toMatchObject({ ok: false });
    expect(await invoke('', [1])).toMatchObject({ ok: false });
    expect(await invoke('', new Array(65).fill('C:/jdk'))).toMatchObject({ ok: false });
  });

  it('refuses an untrusted sender', async () => {
    mocks.assertTrustedAppRenderer.mockImplementation(() => {
      throw new Error('nope');
    });
    expect(await invoke('', [])).toMatchObject({ ok: false });
  });
});

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
