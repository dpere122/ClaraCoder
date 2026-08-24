import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path = require('path');
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => tmpdir()),
    setPath: vi.fn(),
    isPackaged: false,
  },
}));

import { isUsablePythonVenv } from './paths';

describe('isUsablePythonVenv', () => {
  let root: string;

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is false when pyvenv.cfg is missing even if python.exe exists', () => {
    root = mkdtempSync(path.join(tmpdir(), 'clara-venv-'));
    mkdirSync(path.join(root, 'Scripts'), { recursive: true });
    writeFileSync(path.join(root, 'Scripts', 'python.exe'), '');
    expect(isUsablePythonVenv(root)).toBe(false);
  });

  it('is true when pyvenv.cfg is present', () => {
    root = mkdtempSync(path.join(tmpdir(), 'clara-venv-'));
    writeFileSync(path.join(root, 'pyvenv.cfg'), 'home = /tmp\n');
    expect(isUsablePythonVenv(root)).toBe(true);
  });
});
