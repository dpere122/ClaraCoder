/**
 * Electron main process entry: Python sidecar, IPC, workspace watch, and BrowserWindows.
 * Privileged schemes (`nemo-tts`, `nemo-asset`) must register before `app.whenReady`.
 */
import { mkdir } from 'fs/promises';
import { app, BrowserWindow } from 'electron';
import { registerPrivilegedSchemes } from './protocol/register-privileged';
import { ensurePythonServer } from './python/server';
import { registerNemoTtsStreamProtocol } from './protocol/nemo-tts';
import { registerNemoAssetProtocol } from './protocol/nemo-asset';
import { loadConfig, loadConfigSync } from './config/load-save';
import { setHealthMetricsEnabled, syncPythonLogLevel } from './ipc/handlers/health';
import { getLlamaManagedRuntimeOverrides } from './llama-server-manager';
import { syncRuntimeConfigToPython } from './python/workspace-sync';
import { applyResolvedUserPath } from './runtime/user-path';
import { clearWorkspaceWatcher, refreshWorkspaceWatcherForCurrentConfig } from './workspace/watcher';
import { createMainWindow } from './windows/main-window';
import { registerAllIpc } from './ipc/register-ipc';
import { killAllWorkspacePtySessions } from './ipc/handlers/workspace-pty';
import { stopAllManagedLlamaServers } from './llama-server-manager';
import { mainState } from './state';
import { envClara } from './env-clara';
import { configureAppDataDir } from './paths';

/**
 * Chromium GPU process often segfaults on Linux Wayland when Vulkan is enabled.
 * Keep native Wayland (x11/XWayland breaks window mapping on Hyprland) but disable
 * hardware GPU. Set CLARA_ENABLE_GPU=1 to opt in to GPU acceleration.
 */
function applyLinuxDisplayWorkarounds(): void {
  if (process.platform !== 'linux') return;
  if (envClara('ENABLE_GPU') === '1') return;

  const onWayland =
    (process.env.XDG_SESSION_TYPE ?? '').toLowerCase() === 'wayland' ||
    Boolean(process.env.WAYLAND_DISPLAY);
  const disableGpu = envClara('DISABLE_GPU') === '1' || onWayland;

  const ozoneOverride = envClara('ELECTRON_OZONE_PLATFORM');
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

// Match the binary / .desktop StartupWMClass on Linux so the window manager
// associates our windows with the `clara-coder` launcher entry (and its icon).
// macOS keeps the display name for the menu bar; userData is pinned to
// `clara-coder` separately in configureAppDataDir().
app.setName(process.platform === 'darwin' ? 'Clara Coder' : 'clara-coder');
// Pin userData to ``clara-coder`` (and migrate ``nemo-wrapper``) before IPC/SQLite/config.
configureAppDataDir();

function extraUserPathFromDisk(): string {
  try {
    return loadConfigSync().workspaceTools?.extraUserPath ?? '';
  } catch {
    return '';
  }
}

// Overlap login-shell PATH probe with app ready / window create so the sidecar
// still inherits the reconstructed PATH without delaying the first paint.
const userPathReady = applyResolvedUserPath({ extraUserPath: extraUserPathFromDisk() }).catch(
  (err) => {
    console.error('[Main] User PATH recovery failed:', err);
  },
);

registerPrivilegedSchemes();
registerAllIpc();

app
  .whenReady()
  .then(async () => {
    // Show UI immediately — packaged Linux launches used to sit dark for up to ~60s
    // while waitForPython polled a sidecar that had already crashed (missing venv deps).
    registerNemoTtsStreamProtocol();
    registerNemoAssetProtocol();
    createMainWindow();

    await userPathReady;
    try {
      await ensurePythonServer();
    } catch (err) {
      console.error('[Main] Python sidecar unavailable — UI already open:', err);
    }
    const config = await loadConfig();
    // Ensure the Model Manager library root exists (default: ~/ClaraCoder/models).
    const modelsDir = config.modelManager?.customModelsDir?.trim();
    if (modelsDir) {
      process.env.CLARA_CUSTOM_MODELS_DIR = modelsDir;
      try {
        await mkdir(modelsDir, { recursive: true });
      } catch (err) {
        console.error('[Main] Could not create custom models directory:', err);
      }
    }
    try {
      await syncPythonLogLevel(config.healthMonitor.logLevel);
      setHealthMetricsEnabled(config.healthMonitor.metricsEnabled);
      await syncRuntimeConfigToPython(config, getLlamaManagedRuntimeOverrides(config));
      await refreshWorkspaceWatcherForCurrentConfig(config);
    } catch (err) {
      console.error('[Main] Python sync at startup failed:', err);
    }
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
