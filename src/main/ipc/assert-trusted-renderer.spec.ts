/**
 * Tests for security/ipc-trust-guards — the trust helpers that gate every
 * ipcMain handler on the primary app window (and app-owned satellites).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mutable mainState mock — the helpers read mainWindow/settingsWindow/healthWindow/
// dependenciesWindow at call time, so tests can swap fakes per case.
vi.mock('../state', () => {
  const state = {
    mainWindow: null as never,
    settingsWindow: null as never,
    healthWindow: null as never,
    dependenciesWindow: null as never,
  };
  return { mainState: state };
});

import {
  isTrustedMainRenderer,
  isTrustedAppRenderer,
  assertTrustedMainRenderer,
  assertTrustedAppRenderer,
  assertTrustedMainRendererOrThrow,
} from './assert-trusted-renderer';
import { mainState } from '../state';

type FakeWC = { __id: string };
type FakeWin = { isDestroyed(): boolean; webContents: FakeWC };

function win(wc: FakeWC, destroyed = false): FakeWin {
  return { isDestroyed: () => destroyed, webContents: wc };
}

function event(sender: FakeWC): { sender: FakeWC } {
  return { sender };
}

const wcMain = { __id: 'main' };
const wcSettings = { __id: 'settings' };
const wcHealth = { __id: 'health' };
const wcDeps = { __id: 'deps' };
const wcForeign = { __id: 'foreign' };

beforeEach(() => {
  mainState.mainWindow = null as never;
  mainState.settingsWindow = null as never;
  mainState.healthWindow = null as never;
  mainState.dependenciesWindow = null as never;
});

describe('isTrustedMainRenderer', () => {
  it('trusts the primary main window webContents', () => {
    mainState.mainWindow = win(wcMain) as never;
    expect(isTrustedMainRenderer(wcMain)).toBe(true);
  });

  it('rejects a foreign webContents', () => {
    mainState.mainWindow = win(wcMain) as never;
    expect(isTrustedMainRenderer(wcForeign)).toBe(false);
  });

  it('rejects when the main window is destroyed', () => {
    mainState.mainWindow = win(wcMain, true) as never;
    expect(isTrustedMainRenderer(wcMain)).toBe(false);
  });

  it('rejects when no main window is set', () => {
    expect(isTrustedMainRenderer(wcMain)).toBe(false);
  });

  it('does not trust satellite app windows (settings/health/deps)', () => {
    mainState.mainWindow = win(wcMain) as never;
    mainState.settingsWindow = win(wcSettings) as never;
    expect(isTrustedMainRenderer(wcSettings)).toBe(false);
  });
});

describe('isTrustedAppRenderer', () => {
  it('trusts the main window', () => {
    mainState.mainWindow = win(wcMain) as never;
    expect(isTrustedAppRenderer(wcMain)).toBe(true);
  });

  it('trusts the settings, health, and dependencies satellite windows', () => {
    mainState.settingsWindow = win(wcSettings) as never;
    mainState.healthWindow = win(wcHealth) as never;
    mainState.dependenciesWindow = win(wcDeps) as never;
    expect(isTrustedAppRenderer(wcSettings)).toBe(true);
    expect(isTrustedAppRenderer(wcHealth)).toBe(true);
    expect(isTrustedAppRenderer(wcDeps)).toBe(true);
  });

  it('rejects a foreign webContents even when satellites are set', () => {
    mainState.mainWindow = win(wcMain) as never;
    mainState.settingsWindow = win(wcSettings) as never;
    expect(isTrustedAppRenderer(wcForeign)).toBe(false);
  });

  it('rejects a destroyed satellite window', () => {
    mainState.settingsWindow = win(wcSettings, true) as never;
    expect(isTrustedAppRenderer(wcSettings)).toBe(false);
  });
});

describe('assert helpers throw on untrusted', () => {
  it('assertTrustedMainRenderer throws Untrusted IPC sender', () => {
    mainState.mainWindow = win(wcMain) as never;
    expect(() => assertTrustedMainRenderer(event(wcForeign) as never)).toThrow(
      'Untrusted IPC sender',
    );
  });

  it('assertTrustedMainRenderer does not throw for the main window', () => {
    mainState.mainWindow = win(wcMain) as never;
    expect(() => assertTrustedMainRenderer(event(wcMain) as never)).not.toThrow();
  });

  it('assertTrustedAppRenderer throws for a foreign sender', () => {
    mainState.settingsWindow = win(wcSettings) as never;
    expect(() => assertTrustedAppRenderer(event(wcForeign) as never)).toThrow(
      'Untrusted IPC sender',
    );
  });

  it('assertTrustedAppRenderer accepts the settings satellite', () => {
    mainState.settingsWindow = win(wcSettings) as never;
    expect(() => assertTrustedAppRenderer(event(wcSettings) as never)).not.toThrow();
  });

  it('assertTrustedMainRendererOrThrow mirrors assertTrustedMainRenderer', () => {
    mainState.mainWindow = win(wcMain) as never;
    expect(() => assertTrustedMainRendererOrThrow(event(wcForeign) as never)).toThrow(
      'Untrusted IPC sender',
    );
    expect(() => assertTrustedMainRendererOrThrow(event(wcMain) as never)).not.toThrow();
  });
});
