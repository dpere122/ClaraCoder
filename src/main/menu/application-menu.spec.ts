/**
 * Tests for security/menu-openexternal — external URL validation.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../windows/settings-window', () => ({
  createSettingsWindow: vi.fn(),
  SETTINGS_WINDOW_TABS: [],
}));
vi.mock('../windows/health-window', () => ({ createHealthWindow: vi.fn() }));
vi.mock('../windows/dependencies-window', () => ({ createDependenciesWindow: vi.fn() }));

import { validateExternalUrl } from './application-menu';

describe('validateExternalUrl', () => {
  it.each([
    'https://github.com/dpere122/ClaraCoder',
    'https://github.com/',
    'https://docs.claraverse.ai/',
    'http://github.com/',
  ])('allows allowlisted http(s) hosts: %s', (url) => {
    expect(validateExternalUrl(url)).toBe(true);
  });

  it.each([
    'file:///etc/passwd',
    'data:text/html,<script>',
    'javascript:alert(1)',
    'ftp://github.com/',
    'https://evil.com/',
    'https://github.com.evil.com/',
    'https://user:pass@github.com/',
    '',
    'not a url',
  ])('rejects everything else: %s', (url) => {
    expect(validateExternalUrl(url)).toBe(false);
  });
});
