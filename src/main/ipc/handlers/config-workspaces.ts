import { dialog, ipcMain, type BrowserWindow } from 'electron';
import path = require('path');
import { randomUUID } from 'crypto';
import type {
  AppConfig,
  HealthMonitorConfig,
  Workspace,
  WorkspaceContextSyncExtras,
  WorkspaceMonacoEditorScrollState,
  WorkspaceSystemPromptMutationResult,
  WorkspaceSystemPromptStatus,
} from '../../../shared';
import { findLlmModelLocation } from '../../../shared';
import { FIRST_THEME_ID } from '../../constants';
import { mainState } from '../../state';
import { loadConfig, mergeSettingsConfigSave, updateConfig } from '../../config/load-save';
import { getLlamaManagedRuntimeOverrides } from '../../llama-server-manager';
import {
  syncRuntimeConfigToPython,
  syncWorkspaceContextToPython,
  syncWorkspaceSystemPromptToPython,
  fetchPythonInterpretersFromPython,
  postPythonInterpreterSelection,
} from '../../python/workspace-sync';
import { applyWorkspaceExposeAllFromConfig } from '../../workspace/watcher';
import { refreshWorkspaceWatcherForCurrentConfig } from '../../workspace/watcher';
import {
  clearWorkspaceSystemPromptFile,
  copyWorkspaceSystemPromptFromPath,
  getWorkspaceSystemPromptStatus,
  readWorkspaceSystemPromptText,
  writeWorkspaceSystemPromptText,
} from '../../workspace/system-prompt';
import { getRecentConversations } from '../../menu/recent-conversations';
import { buildMenu } from '../../menu/application-menu';
import { assertTrustedMainRenderer } from '../assert-trusted-renderer';
import { setHealthMetricsEnabled, syncPythonLogLevel } from './health';

/**
 * Push managed system-prompt text into the active Python session immediately.
 * Accepts an optional renderer session id so sync works even when main-state
 * conversation tracking lags the UI (watcher tree not required).
 */
async function resyncActiveSessionSystemPrompt(
  workspaceId: string,
  sessionIdHint?: string | null,
): Promise<void> {
  const sessionId = (sessionIdHint || '').trim() || mainState.activeConversationId;
  if (!sessionId) {
    return;
  }
  const convWs = mainState.activeConversationWorkspaceId;
  if (convWs && convWs !== workspaceId) {
    return;
  }
  try {
    await syncWorkspaceSystemPromptToPython(sessionId, workspaceId);
    if (!mainState.activeConversationWorkspaceId) {
      mainState.activeConversationWorkspaceId = workspaceId;
    }
  } catch (err) {
    console.error('Failed to re-sync workspace system prompt:', err);
  }
}

function sendToWindowIfAlive(win: BrowserWindow | null | undefined, channel: string, payload: unknown): void {
  if (!win || win.isDestroyed()) {
    return;
  }
  try {
    win.webContents.send(channel, payload);
  } catch {
    // Window can be torn down between the check and send.
  }
}

function broadcastConfig(config: AppConfig): void {
  sendToWindowIfAlive(mainState.mainWindow, 'config-updated', config);
  sendToWindowIfAlive(mainState.settingsWindow, 'config-updated', config);
  sendToWindowIfAlive(mainState.healthWindow, 'config-updated', config);
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

  ipcMain.handle(
    'patch-workspace-monaco-scroll',
    async (
      _event,
      workspaceId: string,
      relativePath: string,
      scroll: WorkspaceMonacoEditorScrollState | null,
    ) => {
      const wsId = typeof workspaceId === 'string' ? workspaceId.trim() : '';
      const rel = typeof relativePath === 'string' ? relativePath.replace(/\\/g, '/').trim() : '';
      if (!wsId || !rel) {
        return;
      }
      const scrollTop = scroll?.scrollTop;
      const scrollLeft = scroll?.scrollLeft;
      const validScroll =
        scroll != null &&
        typeof scrollTop === 'number' &&
        !Number.isNaN(scrollTop) &&
        scrollTop >= 0 &&
        typeof scrollLeft === 'number' &&
        !Number.isNaN(scrollLeft) &&
        scrollLeft >= 0;
      await updateConfig((cfg) => {
        const byWs = { ...(cfg.workspaceMonacoScrollByWorkspaceId ?? {}) };
        const wsScroll = { ...(byWs[wsId] ?? {}) };
        if (!validScroll) {
          delete wsScroll[rel];
        } else {
          wsScroll[rel] = { scrollTop, scrollLeft };
        }
        if (Object.keys(wsScroll).length === 0) {
          delete byWs[wsId];
        } else {
          byWs[wsId] = wsScroll;
        }
        cfg.workspaceMonacoScrollByWorkspaceId = byWs;
      });
    },
  );

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

  ipcMain.handle(
    'get-workspace-system-prompt-status',
    async (_event, workspaceId: string): Promise<WorkspaceSystemPromptStatus> => {
      const wid = typeof workspaceId === 'string' ? workspaceId.trim() : '';
      if (!wid) {
        return { hasFile: false, sourceName: '' };
      }
      const config = await loadConfig();
      const workspace = config.workspaces.find((w) => w.id === wid);
      return getWorkspaceSystemPromptStatus(wid, workspace?.systemPromptSourceName);
    },
  );

  ipcMain.handle(
    'pick-workspace-system-prompt',
    async (
      event,
      workspaceId: string,
      sessionId?: string | null,
    ): Promise<WorkspaceSystemPromptMutationResult> => {
      try {
        assertTrustedMainRenderer(event);
      } catch {
        return { ok: false, error: 'Untrusted IPC sender', hasFile: false, sourceName: '' };
      }
      const wid = typeof workspaceId === 'string' ? workspaceId.trim() : '';
      if (!wid) {
        return { ok: false, error: 'Workspace id is required.', hasFile: false, sourceName: '' };
      }
      const config = await loadConfig();
      const workspace = config.workspaces.find((w) => w.id === wid);
      if (!workspace) {
        return { ok: false, error: 'Workspace not found.', hasFile: false, sourceName: '' };
      }
      const parent = mainState.mainWindow;
      if (!parent || parent.isDestroyed()) {
        return {
          ok: false,
          error: 'Main window unavailable.',
          hasFile: false,
          sourceName: workspace.systemPromptSourceName ?? '',
        };
      }
      const result = await dialog.showOpenDialog(parent, {
        properties: ['openFile'],
        defaultPath: workspace.path,
        filters: [
          { name: 'Text', extensions: ['md', 'txt'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      if (result.canceled || result.filePaths.length === 0) {
        const status = await getWorkspaceSystemPromptStatus(wid, workspace.systemPromptSourceName);
        return { ok: true, ...status };
      }
      try {
        const { sourceName } = await copyWorkspaceSystemPromptFromPath(wid, result.filePaths[0]!);
        const next = await updateConfig((cfg) => {
          const ws = cfg.workspaces.find((w) => w.id === wid);
          if (!ws) {
            throw new Error('Workspace not found in config.');
          }
          ws.systemPromptSourceName = sourceName;
        });
        broadcastConfig(next);
        await resyncActiveSessionSystemPrompt(wid, sessionId);
        return { ok: true, hasFile: true, sourceName };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const status = await getWorkspaceSystemPromptStatus(wid, workspace.systemPromptSourceName);
        return { ok: false, error: msg, ...status };
      }
    },
  );

  ipcMain.handle(
    'get-workspace-system-prompt-text',
    async (
      event,
      workspaceId: string,
    ): Promise<{ ok: true; text: string } | { ok: false; error: string; text: string }> => {
      try {
        assertTrustedMainRenderer(event);
      } catch {
        return { ok: false, error: 'Untrusted IPC sender', text: '' };
      }
      const wid = typeof workspaceId === 'string' ? workspaceId.trim() : '';
      if (!wid) {
        return { ok: false, error: 'Workspace id is required.', text: '' };
      }
      try {
        const text = await readWorkspaceSystemPromptText(wid);
        return { ok: true, text };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg, text: '' };
      }
    },
  );

  ipcMain.handle(
    'save-workspace-system-prompt-text',
    async (
      event,
      payload: { workspaceId: string; text: string; sessionId?: string | null },
    ): Promise<WorkspaceSystemPromptMutationResult> => {
      try {
        assertTrustedMainRenderer(event);
      } catch {
        return { ok: false, error: 'Untrusted IPC sender', hasFile: false, sourceName: '' };
      }
      const wid = typeof payload?.workspaceId === 'string' ? payload.workspaceId.trim() : '';
      if (!wid) {
        return { ok: false, error: 'Workspace id is required.', hasFile: false, sourceName: '' };
      }
      try {
        await writeWorkspaceSystemPromptText(wid, typeof payload.text === 'string' ? payload.text : '');
        const config = await loadConfig();
        const existing = config.workspaces.find((w) => w.id === wid);
        const sourceName = (existing?.systemPromptSourceName || '').trim() || 'system-prompt.md';
        const next = await updateConfig((cfg) => {
          const ws = cfg.workspaces.find((w) => w.id === wid);
          if (!ws) {
            throw new Error('Workspace not found in config.');
          }
          ws.systemPromptSourceName = sourceName;
        });
        broadcastConfig(next);
        await resyncActiveSessionSystemPrompt(wid, payload.sessionId);
        return { ok: true, hasFile: true, sourceName };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const config = await loadConfig();
        const workspace = config.workspaces.find((w) => w.id === wid);
        const status = await getWorkspaceSystemPromptStatus(wid, workspace?.systemPromptSourceName);
        return { ok: false, error: msg, ...status };
      }
    },
  );

  ipcMain.handle(
    'clear-workspace-system-prompt',
    async (
      event,
      workspaceId: string,
      sessionId?: string | null,
    ): Promise<WorkspaceSystemPromptMutationResult> => {
      try {
        assertTrustedMainRenderer(event);
      } catch {
        return { ok: false, error: 'Untrusted IPC sender', hasFile: false, sourceName: '' };
      }
      const wid = typeof workspaceId === 'string' ? workspaceId.trim() : '';
      if (!wid) {
        return { ok: false, error: 'Workspace id is required.', hasFile: false, sourceName: '' };
      }
      try {
        await clearWorkspaceSystemPromptFile(wid);
        const next = await updateConfig((cfg) => {
          const ws = cfg.workspaces.find((w) => w.id === wid);
          if (!ws) {
            throw new Error('Workspace not found in config.');
          }
          delete ws.systemPromptSourceName;
        });
        broadcastConfig(next);
        await resyncActiveSessionSystemPrompt(wid, sessionId);
        return { ok: true, hasFile: false, sourceName: '' };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const config = await loadConfig();
        const workspace = config.workspaces.find((w) => w.id === wid);
        const status = await getWorkspaceSystemPromptStatus(wid, workspace?.systemPromptSourceName);
        return { ok: false, error: msg, ...status };
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
    sendToWindowIfAlive(mainState.mainWindow, 'workspace-changed', id);
    broadcastConfig(config);
  });

  ipcMain.handle('set-theme', async (_event, themeId: string) => {
    const config = await updateConfig((cfg) => {
      cfg.themeId = themeId || FIRST_THEME_ID;
    });
    await syncRuntimeConfigToPython(config, getLlamaManagedRuntimeOverrides(config));
    broadcastConfig(config);
    return config;
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
