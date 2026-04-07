/**
 * Electron main process entry: Python sidecar, IPC, workspace watch, and BrowserWindows.
 * Privileged `nemo-tts` scheme must register before `app.whenReady`.
 */
import { app, BrowserWindow } from 'electron';
import { registerPrivilegedNemoTtsScheme } from './protocol/register-privileged';
import { startPythonServer, waitForPython } from './python/server';
import { registerNemoTtsStreamProtocol } from './protocol/nemo-tts';
import { loadConfig } from './config/load-save';
import { syncPythonLogLevel } from './ipc/handlers/health';
import { syncRuntimeConfigToPython } from './python/workspace-sync';
import { clearWorkspaceWatcher, refreshWorkspaceWatcherForCurrentConfig } from './workspace/watcher';
import { createMainWindow } from './windows/main-window';
import { registerAllIpc } from './ipc/register-ipc';
import { mainState } from './state';

registerPrivilegedNemoTtsScheme();
registerAllIpc();

app.whenReady().then(async () => {
  startPythonServer();
  await waitForPython();
  registerNemoTtsStreamProtocol();
  const config = await loadConfig();
  await syncPythonLogLevel(config.healthMonitor.logLevel);
  await syncRuntimeConfigToPython(config);
  await refreshWorkspaceWatcherForCurrentConfig(config);
  createMainWindow();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  clearWorkspaceWatcher();
  if (mainState.pythonProcess) {
    mainState.pythonProcess.kill();
    mainState.pythonProcess = null;
  }
});
