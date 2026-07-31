import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path = require('path');
import { afterEach, describe, expect, it } from 'vitest';
import {
  APP_DATA_DIR_NAME,
  migrateLegacyAppDataDir,
  resolveAppDataDir,
} from './app-data';

describe('migrateLegacyAppDataDir', () => {
  let root: string;

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function makeRoot(): string {
    root = mkdtempSync(path.join(tmpdir(), 'clara-app-data-'));
    return root;
  }

  it('resolves the canonical clara-coder path', () => {
    const r = makeRoot();
    expect(resolveAppDataDir(r)).toBe(path.join(r, APP_DATA_DIR_NAME));
  });

  it('creates an empty target when no legacy data exists', () => {
    const r = makeRoot();
    const result = migrateLegacyAppDataDir(r);
    expect(result.migrated).toBe(false);
    expect(result.target).toBe(path.join(r, 'clara-coder'));
    expect(readdirSync(result.target)).toEqual([]);
  });

  it('renames nemo-wrapper into clara-coder when target is empty', () => {
    const r = makeRoot();
    const legacy = path.join(r, 'nemo-wrapper');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, 'config.json'), '{"ok":true}', 'utf-8');

    const result = migrateLegacyAppDataDir(r);
    expect(result.migrated).toBe(true);
    expect(result.from).toBe(legacy);
    expect(result.method).toBe('rename');
    expect(readFileSync(path.join(result.target, 'config.json'), 'utf-8')).toBe('{"ok":true}');
    expect(existsSync(legacy)).toBe(false);
  });

  it('does not overwrite an existing clara-coder directory', () => {
    const r = makeRoot();
    const target = path.join(r, 'clara-coder');
    const legacy = path.join(r, 'nemo-wrapper');
    mkdirSync(target, { recursive: true });
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(target, 'config.json'), '{"new":true}', 'utf-8');
    writeFileSync(path.join(legacy, 'config.json'), '{"old":true}', 'utf-8');

    const result = migrateLegacyAppDataDir(r);
    expect(result.migrated).toBe(false);
    expect(readFileSync(path.join(target, 'config.json'), 'utf-8')).toBe('{"new":true}');
    expect(readFileSync(path.join(legacy, 'config.json'), 'utf-8')).toBe('{"old":true}');
  });

  it('migrates Clara Coder folder when nemo-wrapper is absent', () => {
    const r = makeRoot();
    const legacy = path.join(r, 'Clara Coder');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, 'config.json'), '{"from":"product"}', 'utf-8');

    const result = migrateLegacyAppDataDir(r);
    expect(result.migrated).toBe(true);
    expect(result.from).toBe(legacy);
    expect(readFileSync(path.join(result.target, 'config.json'), 'utf-8')).toBe('{"from":"product"}');
  });
});
