import { ipcMain } from 'electron';
import path = require('path');
import { randomUUID } from 'crypto';
import type { AppConfig, HealthMonitorConfig, Workspace, WorkspaceContextSyncExtras } from '../../../shared';
import { findLlmModelLocation } from '../../../shared';
import { FIRST_THEME_ID } from '../../constants';
import { mainState } from '../../state';
import { loadConfig, mergeSettingsConfigSave, updateConfig } from '../../config/load-save';
import { getLlamaManagedRuntimeOverrides } from '../../llama-server-manager';
import { syncRuntimeConfigToPython, syncWorkspaceContextToPython, fetchPythonInterpretersFromPython, postPythonInterpreterSelection } from '../../python/workspace-sync';
import { applyWorkspaceExposeAllFromConfig } from '../../workspace/watcher';
import { refreshWorkspaceWatcherForCurrentConfig } from '../../workspace/watcher';
import { getRecentConversations } from '../../menu/recent-conversations';
import { buildMenu } from '../../menu/application-menu';
import { setHealthMetricsEnabled, syncPythonLogLevel } from './health';

function broadcastConfig(config: AppConfig): void {
  mainState.mainWindow?.webContents.send('config-updated', config);
  mainState.settingsWindow?.webContents.send('config-updated', config);
  mainState.healthWindow?.webContents.send('config-updated', config);
}

async function publishConfig(config: AppConfig): Promise<AppConfig> {
  await syncPythonLogLevel(config.healthMonitor.logLevel);
  setHealthMetricsEnabled(config.healthMonitor.metricsEnabled);
  await syncRuntimeConfigToPython(config, getLlamaManagedRuntimeOverrides(config));
  await applyWorkspaceExposeAllFromConfig(config);
  broadcastConfig(config);
  return config;
}

/**
 * Config persistence, workspace CRUD, always-on-top, menu refresh, and workspace context push to Python.
 */
export function registerConfigWorkspacesIpc(): void {
  ipcMain.on('workspace-monaco-unsaved-paths', (event, paths: unknown) => {
    if (!mainState.mainWindow || event.sender !== mainState.mainWindow.webContents) {
      return;
    }
    mainState.monacoWorkspaceUnsavedPaths = Array.isArray(paths)
      ? paths.filter((p): p is string => typeof p === 'string')
      : [];
  });

  ipcMain.handle('get-workspace-monaco-unsaved-paths', () => [...(mainState.monacoWorkspaceUnsavedPaths ?? [])]);

  ipcMain.handle('get-recent-conversations', (_event, limit: number) => getRecentConversations(limit));

  ipcMain.handle('refresh-menu', () => {
    buildMenu();
  });

  ipcMain.handle(
    'set-workspace-context',
    async (
      _event,
      sessionId: string,
      workspacePath: string,
      workspaceContext: string,
      extras?: WorkspaceContextSyncExtras,
    ) => {
      await syncWorkspaceContextToPython(sessionId, workspacePath, workspaceContext, extras);
    },
  );

  ipcMain.handle('list-python-interpreters', async (_event, sessionId: string) => {
    try {
      const data = await fetchPythonInterpretersFromPython(sessionId);
      return { ok: true as const, ...data };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false as const,
        error: msg,
        interpreters: [] as Array<{
          id: string;
          label: string;
          pythonExecutable: string;
          venvPath: string;
        }>,
        activeInterpreterId: null as string | null,
      };
    }
  });

  ipcMain.handle(
    'apply-workspace-python-interpreter',
    async (
      _event,
      payload: { workspaceId: string; sessionId: string; interpreterId: string },
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await postPythonInterpreterSelection(payload.sessionId, payload.interpreterId);
        const config = await updateConfig((cfg) => {
          const workspace = cfg.workspaces.find((w) => w.id === payload.workspaceId);
          if (!workspace) {
            throw new Error('Workspace not found in config.');
          }
          workspace.pythonInterpreterId = payload.interpreterId;
        });
        await syncRuntimeConfigToPython(config, getLlamaManagedRuntimeOverrides(config));
        broadcastConfig(config);
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    },
  );

  ipcMain.handle('load-config', async () => loadConfig());

  ipcMain.handle('save-config', async (_event, config: AppConfig) => {
    const saved = await updateConfig((disk) => mergeSettingsConfigSave(disk, config));
    return publishConfig(saved);
  });

  ipcMain.handle(
    'set-last-active-conversation',
    async (_event, workspaceKey: string, conversationId: string) => {
      const config = await updateConfig((cfg) => {
        if (cfg.lastActiveConversationByWorkspaceId?.[workspaceKey] === conversationId) {
          return;
        }
        cfg.lastActiveConversationByWorkspaceId = {
          ...(cfg.lastActiveConversationByWorkspaceId ?? {}),
          [workspaceKey]: conversationId,
        };
      });
      broadcastConfig(config);
      return config;
    },
  );

  ipcMain.handle('set-active-llm-model', async (_event, modelId: string) => {
    const config = await updateConfig((cfg) => {
      if (!modelId || modelId === cfg.activeLlmModelId) {
        return;
      }
      if (!findLlmModelLocation(cfg.llmProviders, modelId)) {
        return;
      }
      cfg.activeLlmModelId = modelId;
    });
    await syncRuntimeConfigToPython(config, getLlamaManagedRuntimeOverrides(config));
    broadcastConfig(config);
    return config;
  });

  ipcMain.handle('patch-health-monitor', async (_event, patch: Partial<HealthMonitorConfig>) => {
    const config = await updateConfig((cfg) => {
      cfg.healthMonitor = { ...cfg.healthMonitor, ...patch };
    });
    await syncPythonLogLevel(config.healthMonitor.logLevel);
    setHealthMetricsEnabled(config.healthMonitor.metricsEnabled);
    broadcastConfig(config);
    return config;
  });

  ipcMain.handle('get-workspaces', async () => {
    const config = await loadConfig();
    return config.workspaces;
  });

  ipcMain.handle('add-workspace', async (_event, name: string, workspacePath: string) => {
    let workspace!: Workspace;
    const config = await updateConfig((cfg) => {
      workspace = {
        id: randomUUID(),
        name: name || path.basename(workspacePath) || 'New Workspace',
        path: workspacePath,
        createdAt: new Date().toISOString(),
        themeId: cfg.themeId || FIRST_THEME_ID,
      };
      cfg.workspaces.push(workspace);
    });
    await syncRuntimeConfigToPython(config, getLlamaManagedRuntimeOverrides(config));
    await refreshWorkspaceWatcherForCurrentConfig(config);
    broadcastConfig(config);
    return workspace;
  });

  ipcMain.handle('remove-workspace', async (_event, id: string) => {
    const config = await updateConfig((cfg) => {
      cfg.workspaces = cfg.workspaces.filter((w) => w.id !== id);
      if (cfg.currentWorkspaceId === id) {
        cfg.currentWorkspaceId = cfg.workspaces.length > 0 ? cfg.workspaces[0].id : null;
      }
    });
    await syncRuntimeConfigToPython(config, getLlamaManagedRuntimeOverrides(config));
    await refreshWorkspaceWatcherForCurrentConfig(config);
    broadcastConfig(config);
  });

  ipcMain.handle('set-current-workspace', async (_event, id: string | null) => {
    const current = await loadConfig();
    if (id === current.currentWorkspaceId) {
      return;
    }

    const config = await updateConfig((cfg) => {
      cfg.currentWorkspaceId = id;
    });
    await syncRuntimeConfigToPython(config, getLlamaManagedRuntimeOverrides(config));
    await refreshWorkspaceWatcherForCurrentConfig(config);
    mainState.mainWindow?.webContents.send('workspace-changed', id);
    broadcastConfig(config);
  });

  ipcMain.handle('set-workspace-theme', async (_event, workspaceId: string, themeId: string) => {
    const config = await updateConfig((cfg) => {
      const workspace = cfg.workspaces.find((w) => w.id === workspaceId);
      if (workspace) {
        workspace.themeId = themeId;
      }
    });
    await syncRuntimeConfigToPython(config, getLlamaManagedRuntimeOverrides(config));
    broadcastConfig(config);
  });

  ipcMain.handle('set-no-workspace-theme', async (_event, themeId: string) => {
    const config = await updateConfig((cfg) => {
      cfg.noWorkspaceThemeId = themeId;
    });
    await syncRuntimeConfigToPython(config, getLlamaManagedRuntimeOverrides(config));
    broadcastConfig(config);
  });

  ipcMain.handle('get-current-workspace', async () => {
    const config = await loadConfig();
    if (!config.currentWorkspaceId) return null;
    return config.workspaces.find((w) => w.id === config.currentWorkspaceId) || null;
  });

  ipcMain.handle('set-always-on-top', (_event, pinned: boolean) => {
    mainState.mainWindow?.setAlwaysOnTop(pinned);
  });
}
