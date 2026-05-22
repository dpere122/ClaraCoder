/**
 * Electron main process entry: Python sidecar, IPC, workspace watch, and BrowserWindows.
 * Privileged `nemo-tts` scheme must register before `app.whenReady`.
 */
import { app, BrowserWindow } from 'electron';
import { registerPrivilegedNemoTtsScheme } from './protocol/register-privileged';
import { ensurePythonServer } from './python/server';
import { registerNemoTtsStreamProtocol } from './protocol/nemo-tts';
import { loadConfig } from './config/load-save';
import { setHealthMetricsEnabled, syncPythonLogLevel } from './ipc/handlers/health';
import { getLlamaManagedRuntimeOverrides } from './llama-server-manager';
import { syncRuntimeConfigToPython } from './python/workspace-sync';
import { clearWorkspaceWatcher, refreshWorkspaceWatcherForCurrentConfig } from './workspace/watcher';
import { createMainWindow } from './windows/main-window';
import { registerAllIpc } from './ipc/register-ipc';
import { killAllWorkspacePtySessions } from './ipc/handlers/workspace-pty';
import { stopAllManagedLlamaServers } from './llama-server-manager';
import { mainState } from './state';

app.setName('Clara Coder');

registerPrivilegedNemoTtsScheme();
registerAllIpc();

app
  .whenReady()
  .then(async () => {
    try {
      await ensurePythonServer();
    } catch (err) {
      console.error('[Main] Python sidecar unavailable — UI will still open:', err);
    }
    registerNemoTtsStreamProtocol();
    const config = await loadConfig();
    try {
      await syncPythonLogLevel(config.healthMonitor.logLevel);
      setHealthMetricsEnabled(config.healthMonitor.metricsEnabled);
      await syncRuntimeConfigToPython(config, getLlamaManagedRuntimeOverrides(config));
      await refreshWorkspaceWatcherForCurrentConfig(config);
    } catch (err) {
      console.error('[Main] Python sync at startup failed:', err);
    }
    createMainWindow();
  })
  .catch((err) => {
    console.error(err);
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
  stopAllManagedLlamaServers();
  killAllWorkspacePtySessions();
  clearWorkspaceWatcher();
  if (mainState.pythonProcess) {
    mainState.pythonProcess.kill();
    mainState.pythonProcess = null;
  }
});
