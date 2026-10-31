import type { PreloadIpc } from '../preload-ipc';
import type { AppReleaseListResult, AppUpdateActionResult, AppUpdateState } from '../../shared/app-updater';

/** App version and the Updates window (release list, verified download, install). */
export const createUpdaterApi = (ipcRenderer: PreloadIpc) => ({
  appVersion: () => ipcRenderer.invoke('app:get-version') as Promise<string>,
  updaterListReleases: (force?: boolean) =>
    ipcRenderer.invoke('updater:list-releases', force === true) as Promise<AppReleaseListResult>,
  updaterGetState: () => ipcRenderer.invoke('updater:get-state') as Promise<AppUpdateState | null>,
  updaterDownload: (version: string) =>
    ipcRenderer.invoke('updater:download', version) as Promise<AppUpdateActionResult>,
  updaterCancel: () => ipcRenderer.invoke('updater:cancel') as Promise<AppUpdateActionResult>,
  updaterInstallNow: () => ipcRenderer.invoke('updater:install-now') as Promise<AppUpdateActionResult>,
  updaterInstallOnQuit: () => ipcRenderer.invoke('updater:install-on-quit') as Promise<AppUpdateActionResult>,
  openUpdaterWindow: () => ipcRenderer.send('open-updater-window'),
  closeUpdaterWindow: () => ipcRenderer.send('close-updater-window'),
  onUpdaterState: (callback: (event: unknown, state: AppUpdateState) => void) =>
    ipcRenderer.on('updater:state', callback),
  offUpdaterState: (callback: (event: unknown, state: AppUpdateState) => void) =>
    ipcRenderer.removeListener('updater:state', callback),
});
