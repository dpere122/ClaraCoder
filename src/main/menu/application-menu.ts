import { Menu, shell } from 'electron';
import type Electron from 'electron';
import type { MenuFileCommand, MenuFileCommandAction } from '../../shared';
import { createSettingsWindow, SETTINGS_WINDOW_TABS } from '../windows/settings-window';
import { createHealthWindow } from '../windows/health-window';
import { createDependenciesWindow } from '../windows/dependencies-window';
import { mainState } from '../state';
import { getRecentWorkspaces } from './recent-workspaces';
import { loadConfigSync } from '../config/load-save';

/** Hosts permitted for Documentation / shell.openExternal. */
const ALLOWED_EXTERNAL_HOSTS = new Set(['github.com', 'docs.claraverse.ai']);

/** Pinned Clara docs URL (must pass {@link validateExternalUrl}). */
const DOCUMENTATION_URL = 'https://github.com/dpere122/ClaraCoder';

/**
 * Only http(s) URLs on the small host allowlist may be opened externally.
 * Rejects file:, data:, javascript:, and other schemes.
 */
export function validateExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    if (parsed.username || parsed.password) {
      return false;
    }
    return ALLOWED_EXTERNAL_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function openExternalUrl(url: string): void {
  if (!validateExternalUrl(url)) {
    console.warn(`[Main] Blocked openExternal for disallowed URL: ${url}`);
    return;
  }
  void shell.openExternal(url);
}

function sendFileMenuCommand(action: MenuFileCommandAction, workspaceId?: string): void {
  const win = mainState.mainWindow;
  if (!win || win.isDestroyed()) {
    return;
  }
  const payload: MenuFileCommand = workspaceId ? { action, workspaceId } : { action };
  try {
    win.webContents.send('menu-file-command', payload);
  } catch {
    // Window can be torn down between the check and send.
  }
}

function currentWorkspaceIdSafe(): string | null {
  try {
    return loadConfigSync().currentWorkspaceId ?? null;
  } catch {
    return null;
  }
}

function buildFileMenuTemplate(): Electron.MenuItemConstructorOptions {
  const recent = getRecentWorkspaces();
  const currentId = currentWorkspaceIdSafe();
  const hasWorkspace = !!currentId;
  const recentSubmenu: Electron.MenuItemConstructorOptions[] =
    recent.length === 0
      ? [{ label: 'No recent workspaces', enabled: false }]
      : recent.map(
          (ws): Electron.MenuItemConstructorOptions & { radioGroup: string } => ({
            label: ws.name,
            type: 'radio' as const,
            radioGroup: 'open-recent-workspace',
            checked: ws.id === currentId,
            click: () => sendFileMenuCommand('open-recent', ws.id),
          }),
        );

  return {
    label: 'File',
    submenu: [
      {
        label: 'Open Folder',
        accelerator: 'CmdOrCtrl+O',
        click: () => sendFileMenuCommand('open-folder'),
      },
      { label: 'Open Recent', submenu: recentSubmenu },
      { type: 'separator' },
      {
        label: 'New File',
        accelerator: 'CmdOrCtrl+N',
        enabled: hasWorkspace,
        click: () => sendFileMenuCommand('new-file'),
      },
      {
        label: 'New Folder',
        enabled: hasWorkspace,
        click: () => sendFileMenuCommand('new-folder'),
      },
      {
        label: 'New Agent',
        click: () => sendFileMenuCommand('new-agent'),
      },
      {
        label: 'New Terminal',
        accelerator: 'CmdOrCtrl+Shift+`',
        enabled: hasWorkspace,
        click: () => sendFileMenuCommand('new-terminal'),
      },
      { label: 'Exit', role: 'quit' },
    ],
  };
}

function buildSettingsMenuTemplate(): Electron.MenuItemConstructorOptions[] {
  return SETTINGS_WINDOW_TABS.map((tab, index) => ({
    label: tab.label,
    accelerator: index === 0 ? 'CmdOrCtrl+,' : undefined,
    click: () => createSettingsWindow(tab.id),
  }));
}

function buildWindowMenuTemplate(): Electron.MenuItemConstructorOptions[] {
  if (process.platform === 'darwin') {
    return [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }];
  }
  return [{ role: 'minimize' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'close' }];
}

/** Native application menu template (File + Settings + …). Exported for tests. */
export function buildApplicationMenuTemplate(): Electron.MenuItemConstructorOptions[] {
  return [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    buildFileMenuTemplate(),
    { label: 'Settings', submenu: buildSettingsMenuTemplate() },
    {
      label: 'Dependencies',
      submenu: [{ label: 'Open', click: () => createDependenciesWindow() }],
    },
    {
      label: 'Health',
      submenu: [{ label: 'Open', click: () => createHealthWindow() }],
    },
    { label: 'Window', submenu: buildWindowMenuTemplate() },
  ];
}

/**
 * Native application menu: Alt fallback on Windows/Linux and keyboard accelerators.
 * Titlebar Settings/Dependencies/Health/File use themed in-renderer controls instead of Menu.popup.
 */
export function buildMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildApplicationMenuTemplate()));
}

/** Opens the docs URL from renderer IPC. */
export function openDocumentation(): void {
  openExternalUrl(DOCUMENTATION_URL);
}
