/**
 * Settings tab IPC is queued until the renderer has subscribed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
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
  settingsWindowParentOptions: () => ({}),
}));

import { BrowserWindow } from 'electron';
import { mainState } from '../state';
import {
  createSettingsWindow,
  notifySettingsRendererReady,
  resetSettingsTabDelivery,
} from './settings-window';

function fakeWin() {
  const send = vi.fn();
  return {
    isDestroyed: () => false,
    focus: vi.fn(),
    webContents: { send },
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
});
