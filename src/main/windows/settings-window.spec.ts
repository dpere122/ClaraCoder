/**
 * Settings tab IPC is queued until the renderer has subscribed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const workArea = vi.hoisted(() => ({ width: 1920, height: 1040 }));

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  screen: { getDisplayMatching: vi.fn(() => ({ workAreaSize: workArea })) },
}));

vi.mock('../state', () => {
  const state = {
    mainWindow: null as never,
    settingsWindow: null as never,
  };
  return { mainState: state };
});

vi.mock('../constants', () => ({ DEV_SERVER_URL: '' }));
vi.mock('../utils/app-icon', () => ({ resolveAppIconPath: () => null }));
vi.mock('../utils/harden-browser-window', () => ({
  framelessWindowShapeOptions: () => ({}),
  hardenBrowserWindow: vi.fn(),
  secureWebPreferences: () => ({}),
}));
vi.mock('../utils/reveal-browser-window', () => ({
  attachBrowserWindowRevealFallbacks: vi.fn(),
  returnFocusToParentOnClose: vi.fn(),
  settingsWindowParentOptions: () => ({}),
}));

import { BrowserWindow } from 'electron';
import { mainState } from '../state';
import { returnFocusToParentOnClose } from '../utils/reveal-browser-window';
import {
  createSettingsWindow,
  notifySettingsRendererReady,
  parseSettingsWindowTab,
  resetSettingsTabDelivery,
  settingsWindowSize,
  SETTINGS_WINDOW_TABS,
} from './settings-window';

function fakeWin() {
  const send = vi.fn();
  return {
    isDestroyed: () => false,
    focus: vi.fn(),
    getBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
    webContents: { send, isDestroyed: () => false },
  };
}

describe('settings tab delivery', () => {
  beforeEach(() => {
    resetSettingsTabDelivery();
    mainState.mainWindow = fakeWin() as never;
    mainState.settingsWindow = fakeWin() as never;
  });

  it('does not send settings-select-tab before the renderer is ready', () => {
    createSettingsWindow('audio');
    expect(mainState.settingsWindow?.webContents.send).not.toHaveBeenCalledWith(
      'settings-select-tab',
      'audio',
    );
  });

  it('flushes the last queued tab when the renderer becomes ready', () => {
    createSettingsWindow('audio');
    createSettingsWindow('tools');
    notifySettingsRendererReady(mainState.settingsWindow!.webContents);
    expect(mainState.settingsWindow?.webContents.send).toHaveBeenCalledTimes(1);
    expect(mainState.settingsWindow?.webContents.send).toHaveBeenCalledWith(
      'settings-select-tab',
      'tools',
    );
  });

  it('sends immediately after the renderer is ready', () => {
    notifySettingsRendererReady(mainState.settingsWindow!.webContents);
    createSettingsWindow('monaco');
    expect(mainState.settingsWindow?.webContents.send).toHaveBeenCalledWith(
      'settings-select-tab',
      'monaco',
    );
  });

  it('ignores ready from a foreign webContents', () => {
    createSettingsWindow('audio');
    notifySettingsRendererReady({ send: vi.fn() } as never);
    expect(mainState.settingsWindow?.webContents.send).not.toHaveBeenCalledWith(
      'settings-select-tab',
      'audio',
    );
  });

  it('clears any live theme preview in the remaining windows when the window closes', () => {
    mainState.settingsWindow = null as never;
    const handlers = new Map<string, () => void>();
    const created = {
      ...fakeWin(),
      on: vi.fn((event: string, cb: () => void) => void handlers.set(event, cb)),
      removeMenu: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn(),
    };
    vi.mocked(BrowserWindow).mockImplementationOnce(function () {
      return created as never;
    });

    createSettingsWindow('themes');
    expect(mainState.settingsWindow).toBe(created);
    handlers.get('closed')!();
    expect(mainState.settingsWindow).toBeNull();
    expect(mainState.mainWindow?.webContents.send).toHaveBeenCalledWith('theme-preview', null);
  });

  it('hands focus back to the main window when Settings closes', () => {
    mainState.settingsWindow = null as never;
    const created = { ...fakeWin(), on: vi.fn(), removeMenu: vi.fn(), loadFile: vi.fn(), loadURL: vi.fn() };
    vi.mocked(BrowserWindow).mockImplementationOnce(function () {
      return created as never;
    });

    createSettingsWindow();
    expect(returnFocusToParentOnClose).toHaveBeenCalledWith(created, mainState.mainWindow);
  });

  it('closes cleanly on quit, when the main webContents is gone before its window', () => {
    mainState.settingsWindow = null as never;
    const handlers = new Map<string, () => void>();
    const created = {
      ...fakeWin(),
      on: vi.fn((event: string, cb: () => void) => void handlers.set(event, cb)),
      removeMenu: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn(),
    };
    vi.mocked(BrowserWindow).mockImplementationOnce(function () {
      return created as never;
    });

    createSettingsWindow();
    const main = mainState.mainWindow as unknown as ReturnType<typeof fakeWin>;
    main.webContents.isDestroyed = () => true;
    main.webContents.send.mockImplementation(() => {
      throw new TypeError('Object has been destroyed');
    });
    expect(() => handlers.get('closed')!()).not.toThrow();
    expect(mainState.settingsWindow).toBeNull();
  });
});

describe('parseSettingsWindowTab', () => {
  it('accepts every tab the Settings menus list', () => {
    for (const tab of SETTINGS_WINDOW_TABS) {
      expect(parseSettingsWindowTab(tab.id)).toBe(tab.id);
    }
    expect(parseSettingsWindowTab('mcp')).toBe('mcp');
  });

  it('rejects unknown and non-string values', () => {
    expect(parseSettingsWindowTab('help')).toBeUndefined();
    expect(parseSettingsWindowTab(undefined)).toBeUndefined();
    expect(parseSettingsWindowTab(3)).toBeUndefined();
  });
});

describe('settings window size', () => {
  beforeEach(() => {
    resetSettingsTabDelivery();
    mainState.mainWindow = fakeWin() as never;
    mainState.settingsWindow = null as never;
    workArea.width = 1920;
    workArea.height = 1040;
    vi.mocked(BrowserWindow).mockClear();
  });

  function createdOptions(): Record<string, unknown> {
    vi.mocked(BrowserWindow).mockImplementationOnce(function () {
      return { ...fakeWin(), on: vi.fn(), removeMenu: vi.fn(), loadFile: vi.fn(), loadURL: vi.fn() } as never;
    });
    createSettingsWindow();
    return vi.mocked(BrowserWindow).mock.calls[0][0] as Record<string, unknown>;
  }

  it('opens at its one size and cannot be resized or maximized', () => {
    expect(createdOptions()).toMatchObject({
      width: 1680,
      height: 980,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
    });
  });

  it('fits a display smaller than its design size', () => {
    workArea.width = 1366;
    workArea.height = 728;
    expect(createdOptions()).toMatchObject({ width: 1366, height: 728, resizable: false });
  });

  it('falls back to the design size when the display is unknown', () => {
    expect(settingsWindowSize(null)).toEqual({ width: 1680, height: 980 });
    expect(settingsWindowSize({ width: 0, height: 0 })).toEqual({ width: 1680, height: 980 });
    expect(settingsWindowSize({ width: 2560.5, height: 900.9 })).toEqual({ width: 1680, height: 900 });
  });
});
