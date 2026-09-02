/**
 * Tests for security/menu-openexternal — external URL validation —
 * and the File menu template (Open Recent + create actions).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
vi.mock('../state', () => ({
  mainState: { mainWindow: null },
}));
vi.mock('../config/load-save', () => ({
  loadConfigSync: vi.fn(() => ({ currentWorkspaceId: 'ws-b', workspaces: [] })),
}));
vi.mock('./recent-workspaces', () => ({
  getRecentWorkspaces: vi.fn(() => [
    { id: 'ws-b', name: 'Beta', path: '/b', createdAt: '2026-02-01T00:00:00.000Z' },
    { id: 'ws-a', name: 'Alpha', path: '/a', createdAt: '2026-01-01T00:00:00.000Z' },
  ]),
}));

import type Electron from 'electron';
import { validateExternalUrl, buildApplicationMenuTemplate } from './application-menu';
import { getRecentWorkspaces } from './recent-workspaces';

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

describe('buildApplicationMenuTemplate File menu', () => {
  beforeEach(() => {
    vi.mocked(getRecentWorkspaces).mockReturnValue([
      { id: 'ws-b', name: 'Beta', path: '/b', createdAt: '2026-02-01T00:00:00.000Z' },
      { id: 'ws-a', name: 'Alpha', path: '/a', createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  function fileMenu(): Electron.MenuItemConstructorOptions {
    const template = buildApplicationMenuTemplate();
    const file = template.find((item) => item.label === 'File');
    expect(file).toBeDefined();
    return file!;
  }

  function fileLabels(): string[] {
    const submenu = fileMenu().submenu;
    expect(Array.isArray(submenu)).toBe(true);
    return (submenu as Electron.MenuItemConstructorOptions[]).map((item) =>
      item.type === 'separator' ? '---' : String(item.label ?? ''),
    );
  }

  it('includes File items in the specified order', () => {
    expect(fileLabels()).toEqual([
      'Open Folder',
      'Open Recent',
      '---',
      'New File',
      'New Folder',
      'New Agent',
      'New Terminal',
      'Exit',
    ]);
  });

  it('lists recent workspaces in the Open Recent submenu', () => {
    const submenu = fileMenu().submenu as Electron.MenuItemConstructorOptions[];
    const recent = submenu.find((item) => item.label === 'Open Recent');
    expect(recent?.submenu).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Beta',
          type: 'radio',
          radioGroup: 'open-recent-workspace',
          checked: true,
        }),
        expect.objectContaining({
          label: 'Alpha',
          type: 'radio',
          radioGroup: 'open-recent-workspace',
          checked: false,
        }),
      ]),
    );
  });

  it('uses role quit for File Exit on every platform', () => {
    const submenu = fileMenu().submenu as Electron.MenuItemConstructorOptions[];
    const exit = submenu.find((item) => item.label === 'Exit');
    expect(exit).toEqual(
      expect.objectContaining({ label: 'Exit', role: 'quit' }),
    );
    expect(exit?.click).toBeUndefined();
  });

  it('disables New File / New Folder / New Terminal without a workspace', async () => {
    const { loadConfigSync } = await import('../config/load-save');
    vi.mocked(loadConfigSync).mockReturnValueOnce({
      currentWorkspaceId: null,
      workspaces: [],
    } as ReturnType<typeof loadConfigSync>);
    const submenu = fileMenu().submenu as Electron.MenuItemConstructorOptions[];
    expect(submenu.find((item) => item.label === 'New File')?.enabled).toBe(false);
    expect(submenu.find((item) => item.label === 'New Folder')?.enabled).toBe(false);
    expect(submenu.find((item) => item.label === 'New Terminal')?.enabled).toBe(false);
    expect(submenu.find((item) => item.label === 'New Agent')?.enabled).not.toBe(false);
  });

  it('shows an empty-state item when there are no recent workspaces', () => {
    vi.mocked(getRecentWorkspaces).mockReturnValueOnce([]);
    const submenu = fileMenu().submenu as Electron.MenuItemConstructorOptions[];
    const recent = submenu.find((item) => item.label === 'Open Recent');
    expect(recent?.submenu).toEqual([
      expect.objectContaining({ label: 'No recent workspaces', enabled: false }),
    ]);
  });
});
