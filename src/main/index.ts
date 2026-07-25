/**
 * Electron main process entry: Python sidecar, IPC, workspace watch, and BrowserWindows.
 * Privileged schemes (`nemo-tts`, `nemo-asset`) must register before `app.whenReady`.
 */
import { app, BrowserWindow } from 'electron';
import { registerPrivilegedSchemes } from './protocol/register-privileged';
import { ensurePythonServer } from './python/server';
import { registerNemoTtsStreamProtocol } from './protocol/nemo-tts';
import { registerNemoAssetProtocol } from './protocol/nemo-asset';
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

/**
 * Chromium GPU process often segfaults on Linux Wayland when Vulkan is enabled.
 * Keep native Wayland (x11/XWayland breaks window mapping on Hyprland) but disable
 * hardware GPU. Set NEMO_ENABLE_GPU=1 to opt in to GPU acceleration.
 */
function applyLinuxDisplayWorkarounds(): void {
  if (process.platform !== 'linux') return;
  if (process.env.NEMO_ENABLE_GPU === '1') return;

  const onWayland =
    (process.env.XDG_SESSION_TYPE ?? '').toLowerCase() === 'wayland' ||
    Boolean(process.env.WAYLAND_DISPLAY);
  const disableGpu = process.env.NEMO_DISABLE_GPU === '1' || onWayland;

  const ozoneOverride = process.env.NEMO_ELECTRON_OZONE_PLATFORM?.trim();
  if (ozoneOverride) {
    app.commandLine.appendSwitch('ozone-platform', ozoneOverride);
  } else if (onWayland) {
    app.commandLine.appendSwitch('enable-features', 'UseOzonePlatform,WaylandWindowDecorations');
    app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
    app.commandLine.appendSwitch('ozone-platform', 'wayland');
  }

  if (disableGpu) {
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('disable-features', 'Vulkan');
  }
}

applyLinuxDisplayWorkarounds();

app.setName('Clara Coder');

registerPrivilegedSchemes();
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
    registerNemoAssetProtocol();
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
  try {
    stopAllManagedLlamaServers();
    killAllWorkspacePtySessions();
    clearWorkspaceWatcher();
    if (mainState.pythonProcess) {
      mainState.pythonProcess.kill();
      mainState.pythonProcess = null;
    }
  } catch (err) {
    console.error('[Main] will-quit cleanup failed:', err);
  }
});
