import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPrimaryEditorFindShortcut } from './editor-find-shortcut';

describe('isPrimaryEditorFindShortcut', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('matches Ctrl+F on Linux', () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' });
    expect(
      isPrimaryEditorFindShortcut({
        type: 'keyDown',
        key: 'f',
        control: true,
        meta: false,
        alt: false,
        shift: false,
      }),
    ).toBe(true);
  });

  it('matches Ctrl+F case-insensitively', () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' });
    expect(
      isPrimaryEditorFindShortcut({
        type: 'keyDown',
        key: 'F',
        control: true,
        meta: false,
        alt: false,
        shift: false,
      }),
    ).toBe(true);
  });

  it('matches Cmd+F on macOS', () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    expect(
      isPrimaryEditorFindShortcut({
        type: 'keyDown',
        key: 'f',
        control: false,
        meta: true,
        alt: false,
        shift: false,
      }),
    ).toBe(true);
  });

  it('rejects Ctrl+Shift+F', () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' });
    expect(
      isPrimaryEditorFindShortcut({
        type: 'keyDown',
        key: 'f',
        control: true,
        meta: false,
        alt: false,
        shift: true,
      }),
    ).toBe(false);
  });

  it('rejects keyUp', () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' });
    expect(
      isPrimaryEditorFindShortcut({
        type: 'keyUp',
        key: 'f',
        control: true,
        meta: false,
        alt: false,
        shift: false,
      }),
    ).toBe(false);
  });

  it('rejects bare F', () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' });
    expect(
      isPrimaryEditorFindShortcut({
        type: 'keyDown',
        key: 'f',
        control: false,
        meta: false,
        alt: false,
        shift: false,
      }),
    ).toBe(false);
  });
});
