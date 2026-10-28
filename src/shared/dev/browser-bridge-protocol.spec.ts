import { describe, expect, it } from 'vitest';
import {
  browserBridgeSettingsTabForHash,
  browserBridgeUrl,
  browserBridgeWindowForHash,
  isBrowserBridgeToken,
  parseBrowserBridgeParam,
  parseBrowserBridgeWindow,
} from './browser-bridge-protocol';

const endpoint = { port: 4210, token: 'a'.repeat(43) };

describe('isBrowserBridgeToken', () => {
  it('accepts a saved base64url token and rejects junk', () => {
    expect(isBrowserBridgeToken(endpoint.token)).toBe(true);
    expect(isBrowserBridgeToken('short')).toBe(false);
    expect(isBrowserBridgeToken(`${endpoint.token}\n`)).toBe(false);
    expect(parseBrowserBridgeParam(`4210.${endpoint.token}.extra`)).toBeNull();
  });
});

describe('parseBrowserBridgeWindow', () => {
  it('treats a missing header as the main window', () => {
    expect(parseBrowserBridgeWindow(undefined)).toBe('main');
    expect(parseBrowserBridgeWindow('')).toBe('main');
  });

  it('accepts known windows and rejects anything else', () => {
    expect(parseBrowserBridgeWindow('settings')).toBe('settings');
    expect(parseBrowserBridgeWindow('health')).toBe('health');
    expect(parseBrowserBridgeWindow('Settings')).toBeNull();
    expect(parseBrowserBridgeWindow('devtools')).toBeNull();
  });
});

describe('browserBridgeWindowForHash', () => {
  it('maps satellite routes to their window', () => {
    expect(browserBridgeWindowForHash('#/settings')).toBe('settings');
    expect(browserBridgeWindowForHash('#/settings?tab=models')).toBe('settings');
    expect(browserBridgeWindowForHash('#/dependencies')).toBe('dependencies');
    expect(browserBridgeWindowForHash('#/health')).toBe('health');
  });

  it('falls back to the main window', () => {
    expect(browserBridgeWindowForHash('')).toBe('main');
    expect(browserBridgeWindowForHash('#/')).toBe('main');
    expect(browserBridgeWindowForHash('#/unknown')).toBe('main');
  });
});

describe('browserBridgeSettingsTabForHash', () => {
  it('reads the tab query of the hash route', () => {
    expect(browserBridgeSettingsTabForHash('#/settings?tab=models')).toBe('models');
    expect(browserBridgeSettingsTabForHash('#/settings')).toBeUndefined();
  });
});

describe('browserBridgeUrl', () => {
  it('builds a tab URL per window that round-trips the endpoint', () => {
    const main = new URL(browserBridgeUrl('http://127.0.0.1:4200', endpoint, 'main'));
    expect(main.hash).toBe('#/');
    expect(parseBrowserBridgeParam(main.searchParams.get('claraBridge'))).toEqual(endpoint);

    expect(new URL(browserBridgeUrl('http://127.0.0.1:4200', endpoint, 'health')).hash).toBe('#/health');
  });

  it('opens Settings on a tab', () => {
    const url = browserBridgeUrl('http://127.0.0.1:4200/', endpoint, 'settings', 'modelManager');
    expect(new URL(url).hash).toBe('#/settings?tab=modelManager');
    expect(browserBridgeWindowForHash(new URL(url).hash)).toBe('settings');
    expect(browserBridgeSettingsTabForHash(new URL(url).hash)).toBe('modelManager');
  });
});
