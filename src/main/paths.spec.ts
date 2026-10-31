import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path = require('path');
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { electronMock } = vi.hoisted(() => {
  const stored: Record<string, string> = {};
  let appDataRoot = require('os').tmpdir() as string;
  return {
    electronMock: {
      app: {
        getPath: vi.fn((name: string) => stored[name] ?? appDataRoot),
        setPath: vi.fn((name: string, value: string) => {
          stored[name] = value;
        }),
        isPackaged: false as boolean,
      },
      stored,
      setAppDataRoot(dir: string) {
        appDataRoot = dir;
      },
      resetStored() {
        for (const key of Object.keys(stored)) delete stored[key];
      },
    },
  };
});

vi.mock('electron', () => electronMock);

import {
  BUNDLED_RUNTIME_MANIFEST_FILE,
  expectedRequirementsHash,
  getBundledPythonExecutable,
  getBundledRuntimeDir,
  getPythonExecutable,
  getRuntimePythonDir,
  isUsablePythonVenv,
  isolatedVenvStaleReason,
  pythonVenvUnusableReason,
  readBundledRuntimeManifest,
  venvBelongsToBundledRuntime,
} from './paths';

const BASE_PY_NAME = process.platform === 'win32' ? 'python.exe' : 'python3';
const VENV_PY = process.platform === 'win32' ? path.join('Scripts', 'python.exe') : path.join('bin', 'python');

function writeStub(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '');
}

function bundledExeUnder(resourcesRoot: string): string {
  return process.platform === 'win32'
    ? path.join(resourcesRoot, 'runtime-python', 'python.exe')
    : path.join(resourcesRoot, 'runtime-python', 'bin', 'python3');
}

describe('isUsablePythonVenv', () => {
  let root: string;

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** Fake base interpreter dir the venv's ``home =`` can point at. */
  function makeBaseHome(): string {
    const home = path.join(root, 'base');
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, BASE_PY_NAME), '');
    return home;
  }

  it('is false when pyvenv.cfg is missing even if python.exe exists', () => {
    root = mkdtempSync(path.join(tmpdir(), 'clara-venv-'));
    mkdirSync(path.join(root, 'Scripts'), { recursive: true });
    writeFileSync(path.join(root, 'Scripts', 'python.exe'), '');
    expect(isUsablePythonVenv(root)).toBe(false);
    expect(pythonVenvUnusableReason(root)).toBe('missing pyvenv.cfg');
  });

  it('is true when pyvenv.cfg is present and its home interpreter exists', () => {
    root = mkdtempSync(path.join(tmpdir(), 'clara-venv-'));
    const home = makeBaseHome();
    writeFileSync(path.join(root, 'pyvenv.cfg'), `home = ${home}\nversion = 3.12.11\n`);
    expect(isUsablePythonVenv(root)).toBe(true);
    expect(pythonVenvUnusableReason(root)).toBeNull();
  });

  it('is false when the home interpreter was removed (uninstalled bundled Python)', () => {
    root = mkdtempSync(path.join(tmpdir(), 'clara-venv-'));
    const gone = path.join(root, 'Programs', 'Clara Coder', 'resources', 'runtime-python');
    writeFileSync(path.join(root, 'pyvenv.cfg'), `home = ${gone}\nversion = 3.12.11\n`);
    expect(isUsablePythonVenv(root)).toBe(false);
    expect(pythonVenvUnusableReason(root)).toContain('base interpreter missing');
  });

  it('is false when home exists but has no interpreter', () => {
    root = mkdtempSync(path.join(tmpdir(), 'clara-venv-'));
    const home = path.join(root, 'empty-home');
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(root, 'pyvenv.cfg'), `home = ${home}\n`);
    expect(isUsablePythonVenv(root)).toBe(false);
  });

  it('tolerates a pyvenv.cfg without a home line', () => {
    root = mkdtempSync(path.join(tmpdir(), 'clara-venv-'));
    writeFileSync(path.join(root, 'pyvenv.cfg'), 'version = 3.12.11\n');
    expect(isUsablePythonVenv(root)).toBe(true);
  });
});

describe('isolatedVenvStaleReason', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'clara-venv-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('ignores overlay venvs (core packages come from the base interpreter)', () => {
    writeFileSync(path.join(root, 'pyvenv.cfg'), 'include-system-site-packages = true\n');
    expect(isolatedVenvStaleReason(root)).toBeNull();
  });

  it('flags an isolated venv whose requirements hash is missing or old', () => {
    const expected = expectedRequirementsHash();
    writeFileSync(path.join(root, 'pyvenv.cfg'), 'include-system-site-packages = false\n');
    if (!expected) {
      expect(isolatedVenvStaleReason(root)).toBeNull();
      return;
    }
    expect(isolatedVenvStaleReason(root)).toContain('out of date');
    writeFileSync(path.join(root, '.clara-requirements-hash'), 'old\n');
    expect(isolatedVenvStaleReason(root)).toContain('out of date');
    writeFileSync(path.join(root, '.clara-requirements-hash'), `${expected}\n`);
    expect(isolatedVenvStaleReason(root)).toBeNull();
  });
});

describe('venvBelongsToBundledRuntime', () => {
  let root: string;

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is true when home equals the bundled exe directory', () => {
    root = mkdtempSync(path.join(tmpdir(), 'clara-belong-'));
    const home = path.join(root, 'runtime-python');
    writeStub(path.join(home, BASE_PY_NAME));
    const venv = path.join(root, 'venv');
    mkdirSync(venv, { recursive: true });
    writeFileSync(path.join(venv, 'pyvenv.cfg'), `home = ${home}\n`);
    expect(venvBelongsToBundledRuntime(venv, path.join(home, BASE_PY_NAME))).toBe(true);
  });

  it('is false when home is missing or points elsewhere', () => {
    root = mkdtempSync(path.join(tmpdir(), 'clara-belong-'));
    const home = path.join(root, 'runtime-python');
    const other = path.join(root, 'other-python');
    writeStub(path.join(home, BASE_PY_NAME));
    writeStub(path.join(other, BASE_PY_NAME));
    const venv = path.join(root, 'venv');
    mkdirSync(venv, { recursive: true });
    writeFileSync(path.join(venv, 'pyvenv.cfg'), `home = ${other}\n`);
    expect(venvBelongsToBundledRuntime(venv, path.join(home, BASE_PY_NAME))).toBe(false);
    writeFileSync(path.join(venv, 'pyvenv.cfg'), 'version = 3.12.11\n');
    expect(venvBelongsToBundledRuntime(venv, path.join(home, BASE_PY_NAME))).toBe(false);
  });

  it.runIf(process.platform === 'win32')('is case-insensitive on win32', () => {
    root = mkdtempSync(path.join(tmpdir(), 'clara-belong-case-'));
    const home = path.join(root, 'Runtime-Python');
    writeStub(path.join(home, 'python.exe'));
    const venv = path.join(root, 'venv');
    mkdirSync(venv, { recursive: true });
    writeFileSync(path.join(venv, 'pyvenv.cfg'), `home = ${home}\n`);
    const mixedExe = path.join(home.toUpperCase(), 'PYTHON.EXE');
    expect(venvBelongsToBundledRuntime(venv, mixedExe)).toBe(true);
  });
});

describe('readBundledRuntimeManifest / getPythonExecutable', () => {
  let tmp: string;
  let prevClara: string | undefined;
  let prevNemo: string | undefined;
  const originalResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath');

  function setResourcesPath(value: string): void {
    Object.defineProperty(process, 'resourcesPath', {
      value,
      configurable: true,
      writable: true,
    });
  }

  function restoreResourcesPath(): void {
    if (originalResources) {
      Object.defineProperty(process, 'resourcesPath', originalResources);
    } else {
      delete (process as { resourcesPath?: string }).resourcesPath;
    }
  }

  function plantBundledExe(): string {
    const exe = bundledExeUnder(process.resourcesPath);
    writeStub(exe);
    return exe;
  }

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'clara-pyexe-'));
    prevClara = process.env.CLARA_PYTHON;
    prevNemo = process.env.NEMO_PYTHON;
    delete process.env.CLARA_PYTHON;
    delete process.env.NEMO_PYTHON;
    electronMock.resetStored();
    electronMock.setAppDataRoot(tmp);
    electronMock.app.setPath('userData', path.join(tmp, 'clara-coder'));
    electronMock.app.isPackaged = true;
    setResourcesPath(path.join(tmp, 'resources'));
  });

  afterEach(() => {
    electronMock.app.isPackaged = false;
    restoreResourcesPath();
    if (prevClara === undefined) delete process.env.CLARA_PYTHON;
    else process.env.CLARA_PYTHON = prevClara;
    if (prevNemo === undefined) delete process.env.NEMO_PYTHON;
    else process.env.NEMO_PYTHON = prevNemo;
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('readBundledRuntimeManifest returns the parsed object', () => {
    mkdirSync(getBundledRuntimeDir(), { recursive: true });
    const manifest = {
      schemaVersion: 1,
      pythonVersion: '3.12.11',
      pbsRelease: '20260113',
      platform: 'win32',
      arch: 'x64',
    };
    writeFileSync(
      path.join(getBundledRuntimeDir(), BUNDLED_RUNTIME_MANIFEST_FILE),
      JSON.stringify(manifest),
    );
    expect(readBundledRuntimeManifest()).toEqual(manifest);
  });

  it('readBundledRuntimeManifest returns null when the file is missing', () => {
    mkdirSync(getBundledRuntimeDir(), { recursive: true });
    expect(readBundledRuntimeManifest()).toBeNull();
  });

  it('readBundledRuntimeManifest returns null when JSON is invalid', () => {
    mkdirSync(getBundledRuntimeDir(), { recursive: true });
    writeFileSync(path.join(getBundledRuntimeDir(), BUNDLED_RUNTIME_MANIFEST_FILE), '{not-json');
    expect(readBundledRuntimeManifest()).toBeNull();
  });

  it('packaged, bundled exe exists, no venv → returns bundled exe', () => {
    const bundled = plantBundledExe();
    expect(getPythonExecutable()).toBe(bundled);
  });

  it('packaged, venv usable with home == dirname(bundled exe) → returns venv python', () => {
    const bundled = plantBundledExe();
    const venvRoot = getRuntimePythonDir();
    const venvExe = path.join(venvRoot, VENV_PY);
    writeStub(venvExe);
    writeFileSync(path.join(venvRoot, 'pyvenv.cfg'), `home = ${path.dirname(bundled)}\n`);
    expect(getPythonExecutable()).toBe(venvExe);
  });

  it('packaged, venv usable but home points elsewhere → returns bundled exe', () => {
    const bundled = plantBundledExe();
    const foreignHome = path.join(tmp, 'foreign-python');
    writeStub(path.join(foreignHome, BASE_PY_NAME));
    const venvRoot = getRuntimePythonDir();
    writeStub(path.join(venvRoot, VENV_PY));
    writeFileSync(path.join(venvRoot, 'pyvenv.cfg'), `home = ${foreignHome}\n`);
    expect(getBundledPythonExecutable()).toBe(bundled);
    expect(getPythonExecutable()).toBe(bundled);
  });

  it('packaged, CLARA_PYTHON set → ignored, returns bundled exe', () => {
    const bundled = plantBundledExe();
    process.env.CLARA_PYTHON = path.join(tmp, 'custom-python.exe');
    expect(getPythonExecutable()).toBe(bundled);
  });

  it('packaged, bundled missing → returns null', () => {
    expect(getPythonExecutable()).toBeNull();
  });

  it('not packaged, CLARA_PYTHON set → returns it', () => {
    electronMock.app.isPackaged = false;
    const override = path.join(tmp, 'dev-python.exe');
    process.env.CLARA_PYTHON = override;
    expect(getPythonExecutable()).toBe(override);
  });
});
