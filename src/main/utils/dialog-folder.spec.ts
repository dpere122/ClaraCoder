import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path = require('path');
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let appData = '';
vi.mock('../paths', () => ({ getAppDataDir: () => appData }));

import { dialogFolderOption, lastDialogFolder, rememberDialogFolder, resetDialogFolderForTests } from './dialog-folder';

describe('dialog folder memory', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'clara-dialog-folder-'));
    appData = path.join(root, 'app-data');
    mkdirSync(appData);
    resetDialogFolderForTests();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('has no folder before anything is picked, so the dialog uses the fallback or Electron default', () => {
    expect(lastDialogFolder()).toBeUndefined();
    expect(dialogFolderOption()).toEqual({});
    expect(dialogFolderOption(root)).toEqual({ defaultPath: root });
  });

  it('starts the next dialog in the folder that held the last pick', () => {
    const projects = path.join(root, 'projects');
    mkdirSync(path.join(projects, 'app'), { recursive: true });

    rememberDialogFolder(path.join(projects, 'app'));

    expect(dialogFolderOption(root)).toEqual({ defaultPath: projects });
  });

  it('keeps the folder across restarts', () => {
    const projects = path.join(root, 'projects');
    mkdirSync(projects);
    rememberDialogFolder(path.join(projects, 'theme.json'));

    resetDialogFolderForTests();

    expect(lastDialogFolder()).toBe(projects);
  });

  it('ignores a remembered folder that no longer exists', () => {
    const gone = path.join(root, 'gone');
    mkdirSync(gone);
    rememberDialogFolder(path.join(gone, 'image.png'));
    rmSync(gone, { recursive: true });

    expect(lastDialogFolder()).toBeUndefined();
    expect(dialogFolderOption(root)).toEqual({ defaultPath: root });
  });

  it('ignores a damaged or relative saved value', () => {
    writeFileSync(path.join(appData, 'dialog-folder.json'), '{"folder":"relative/place"}');
    expect(lastDialogFolder()).toBeUndefined();

    resetDialogFolderForTests();
    writeFileSync(path.join(appData, 'dialog-folder.json'), 'not json');
    expect(lastDialogFolder()).toBeUndefined();
  });

  it('still remembers for the session when the folder cannot be saved', () => {
    const projects = path.join(root, 'projects');
    mkdirSync(projects);
    appData = path.join(root, 'missing-app-data');

    rememberDialogFolder(path.join(projects, 'app'));

    expect(lastDialogFolder()).toBe(projects);
    expect(() => readFileSync(path.join(appData, 'dialog-folder.json'))).toThrow();
  });
});
