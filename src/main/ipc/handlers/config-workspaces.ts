import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent, type WebContents } from 'electron';
import path = require('path');
import { randomUUID } from 'crypto';
import type {
  AppConfig,
  EnsureWorkspaceSystemPromptResult,
  HealthMonitorConfig,
  Workspace,
  WorkspaceContextSyncExtras,
  WorkspaceMonacoEditorScrollState,
  WorkspaceOpenTabsState,
} from '../../../shared';
import {
  findLlmModelLocation,
  normalizeWorkspaceOpenTabsState,
  reorderFavoriteWorkspaces,
  setWorkspaceFavorite,
} from '../../../shared';
import {
  type TutorialProgress,
  type TutorialSnapshot,
  type TutorialTransition,
  type TutorialWindow,
} from '../../../shared/types/tutorial';
import { FIRST_THEME_ID } from '../../constants';
import { mainState } from '../../state';
import { loadConfig, loadTutorialProgress, mergeSettingsConfigSave, setTutorialEnabled, updateConfig, updateTutorialProgress } from '../../config/load-save';
import { getLlamaManagedRuntimeOverrides } from '../../llama-server-manager';
import {
  syncRuntimeConfigToPython,
  syncWorkspaceContextToPython,
  syncWorkspaceSystemPromptToPython,
  fetchPythonInterpretersFromPython,
  postPythonInterpreterSelection,
} from '../../python/workspace-sync';
import { applyResolvedUserPath } from '../../runtime/user-path';
import { applyWorkspaceExposeAllFromConfig } from '../../workspace/watcher';
import { refreshWorkspaceWatcherForCurrentConfig } from '../../workspace/watcher';
import { shutdownAllLspManagersBestEffort } from './lsp-status';
import { ensureWorkspaceSystemPrompt } from '../../workspace/system-prompt';
import { getRecentConversations } from '../../menu/recent-conversations';
import { buildMenu } from '../../menu/application-menu';
import { assertTrustedAppRenderer, assertTrustedMainRenderer } from '../assert-trusted-renderer';
import { setHealthMetricsEnabled, syncPythonLogLevel } from './health';
import {
  dropWorkspaceFromConfig,
  purgeWorkspacePersistedData,
  reconcileLostWorkspaces,
  type ReconcileLostWorkspacesResult,
} from '../../workspace/lost-workspace';
import { applyScreenshotRetention } from '../../web/screenshot-maintenance';

/**
 * Push workspace system-prompt text into the active Python session immediately.
 * Accepts an optional renderer session id so sync works even when main-state
 * conversation tracking lags the UI (watcher tree not required).
 */
async function resyncActiveSessionSystemPrompt(
  workspaceRoot: string,
  workspaceId?: string,
  sessionIdHint?: string | null,
): Promise<void> {
  const sessionId = (sessionIdHint || '').trim() || mainState.activeConversationId;
  if (!sessionId) {
    return;
  }
  const root = (workspaceRoot || '').trim();
  if (!root) {
    return;
  }
  const convWs = mainState.activeConversationWorkspaceId;
  const wid = (workspaceId || '').trim();
  if (wid && convWs && convWs !== wid) {
    return;
  }
  try {
    await syncWorkspaceSystemPromptToPython(sessionId, root);
    if (wid && !mainState.activeConversationWorkspaceId) {
      mainState.activeConversationWorkspaceId = wid;
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
  sendToWindowIfAlive(mainState.dependenciesWindow, 'config-updated', config);
}

// The lease is deliberately transient: closing a window frees it, but never dismisses progress.
let tutorialOwner: WebContents | null = null;
let tutorialLeaseGeneration = 0;
let tutorialRequestedWindow: TutorialWindow | null = null;
let tutorialHandoffTarget: WebContents | null = null;
let tutorialHandoffTimer: ReturnType<typeof setTimeout> | null = null;
const watchedTutorialContents = new WeakSet<WebContents>();
const TUTORIAL_HANDOFF_TIMEOUT_MS = 15_000;

function clearTutorialHandoff(): void {
  tutorialRequestedWindow = null;
  tutorialHandoffTarget = null;
  if (tutorialHandoffTimer) clearTimeout(tutorialHandoffTimer);
  tutorialHandoffTimer = null;
}

function setTutorialHandoff(role: TutorialWindow | null): void {
  clearTutorialHandoff();
  if (!role) return;
  tutorialRequestedWindow = role;
  const target = role === 'home' ? mainState.mainWindow : role === 'settings' ? mainState.settingsWindow : mainState.dependenciesWindow;
  if (target && !target.isDestroyed()) {
    tutorialHandoffTarget = target.webContents;
    watchTutorialOwner(target.webContents);
  }
  // A failed window open must not strand the tour forever. Home can then offer recovery.
  tutorialHandoffTimer = setTimeout(() => {
    if (!tutorialOwner && tutorialRequestedWindow === role) {
      clearTutorialHandoff();
      void readTutorialSnapshot().then(broadcastTutorial).catch((err) => {
        console.error('Failed to publish tutorial handoff timeout:', err);
      });
    }
  }, TUTORIAL_HANDOFF_TIMEOUT_MS);
  tutorialHandoffTimer.unref();
}

function tutorialWindowForSender(sender: WebContents): TutorialWindow | null {
  if (mainState.mainWindow && !mainState.mainWindow.isDestroyed() && mainState.mainWindow.webContents === sender) return 'home';
  if (mainState.dependenciesWindow && !mainState.dependenciesWindow.isDestroyed() && mainState.dependenciesWindow.webContents === sender) return 'dependencies';
  if (mainState.settingsWindow && !mainState.settingsWindow.isDestroyed() && mainState.settingsWindow.webContents === sender) return 'settings';
  return null;
}

function assertTutorialSender(event: IpcMainInvokeEvent): TutorialWindow {
  assertTrustedAppRenderer(event);
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted tutorial frame');
  const role = tutorialWindowForSender(event.sender);
  if (!role) throw new Error('Tutorial is unavailable in this window');
  return role;
}

function tutorialSnapshot(progress: TutorialProgress): TutorialSnapshot {
  if (tutorialOwner?.isDestroyed()) {
    tutorialOwner = null;
    tutorialLeaseGeneration++;
    clearTutorialHandoff();
  }
  return { progress, ownerId: tutorialOwner?.id ?? null, requestedWindow: tutorialRequestedWindow };
}

async function readTutorialSnapshot(): Promise<TutorialSnapshot> {
  return tutorialSnapshot(await loadTutorialProgress());
}

function broadcastTutorial(snapshot: TutorialSnapshot): void {
  // Never send config-updated here: Settings may contain an unsaved, dirty source draft.
  sendToWindowIfAlive(mainState.mainWindow, 'tutorial:updated', snapshot);
  sendToWindowIfAlive(mainState.settingsWindow, 'tutorial:updated', snapshot);
  sendToWindowIfAlive(mainState.dependenciesWindow, 'tutorial:updated', snapshot);
}

function watchTutorialOwner(sender: WebContents): void {
  if (watchedTutorialContents.has(sender)) return;
  watchedTutorialContents.add(sender);
  const releaseLostWindow = (): void => {
    if (tutorialOwner !== sender && (tutorialOwner || tutorialHandoffTarget !== sender)) return;
    tutorialOwner = null;
    tutorialLeaseGeneration++;
    clearTutorialHandoff();
    void readTutorialSnapshot().then(broadcastTutorial).catch((err) => {
      console.error('Failed to publish tutorial window closure:', err);
    });
  };
  sender.once('destroyed', releaseLostWindow);
  // WebContents can survive a renderer crash and later be reloaded.
  sender.on('render-process-gone', releaseLostWindow);
}

async function publishLostWorkspaceReconcile(result: ReconcileLostWorkspacesResult): Promise<void> {
  if (result.removedIds.length === 0 && !result.currentWorkspaceChanged) {
    return;
  }
  if (result.currentWorkspaceChanged) {
    await shutdownAllLspManagersBestEffort();
    sendToWindowIfAlive(mainState.mainWindow, 'workspace-changed', result.config.currentWorkspaceId);
  }
  broadcastConfig(result.config);
  buildMenu();
  void applyPublishedConfigRuntime(result.config).catch((err) => {
    console.error('Failed to apply config after lost-workspace reconcile:', err);
  });
  void refreshWorkspaceWatcherForCurrentConfig(result.config).catch((err) => {
    console.error('Failed to refresh workspace watcher after lost-workspace reconcile:', err);
  });
}

async function applyPublishedConfigRuntime(config: AppConfig): Promise<void> {
  await applyResolvedUserPath({ extraUserPath: config.workspaceTools?.extraUserPath ?? '' });
  await syncPythonLogLevel(config.healthMonitor.logLevel);
  setHealthMetricsEnabled(config.healthMonitor.metricsEnabled);
  // Getter: read managed overrides live at send time so a concurrent start's real ports
  // are not clobbered by this (possibly delayed) save-time snapshot.
  await syncRuntimeConfigToPython(config, () => getLlamaManagedRuntimeOverrides(config));
  await applyWorkspaceExposeAllFromConfig(config);
}

/** Drop folders that vanished on disk, then publish so windows and the File menu stay in sync. */
export async function reconcileLostWorkspacesOnStartup(): Promise<AppConfig> {
  const result = await reconcileLostWorkspaces();
  await publishLostWorkspaceReconcile(result);
  return result.config;
}

/**
 * Config persistence, workspace CRUD, always-on-top, menu refresh, and workspace context push to Python.
 */
export function registerConfigWorkspacesIpc(): void {
  app.on('browser-window-created', (_event, win) => {
    // mainState is assigned just after BrowserWindow's constructor returns.
    setImmediate(() => {
      if (!tutorialOwner && tutorialRequestedWindow && !win.isDestroyed() &&
          tutorialWindowForSender(win.webContents) === tutorialRequestedWindow) {
        tutorialHandoffTarget = win.webContents;
        watchTutorialOwner(win.webContents);
      }
    });
  });

  ipcMain.handle('tutorial:get-snapshot', async (event) => {
    const role = assertTutorialSender(event);
    if (!tutorialOwner && tutorialRequestedWindow === role) {
      tutorialHandoffTarget = event.sender;
      watchTutorialOwner(event.sender);
    }
    return readTutorialSnapshot();
  });

  ipcMain.handle('tutorial:claim', async (event, requested: TutorialWindow) => {
    const role = assertTutorialSender(event);
    if (requested !== role) throw new Error('Tutorial window role does not match the sender');
    // Claim before awaiting disk I/O: concurrent windows cannot both take the lease.
    let claimedHere = false;
    if (!tutorialOwner && (!tutorialRequestedWindow || tutorialRequestedWindow === role)) {
      tutorialOwner = event.sender;
      tutorialLeaseGeneration++;
      claimedHere = true;
      clearTutorialHandoff();
      watchTutorialOwner(event.sender);
    }
    const claimGeneration = tutorialLeaseGeneration;
    try {
      const snapshot = await readTutorialSnapshot();
      const acquired = tutorialOwner === event.sender && tutorialLeaseGeneration === claimGeneration && !event.sender.isDestroyed();
      if (acquired) broadcastTutorial(snapshot);
      return { acquired, snapshot };
    } catch (err) {
      // An unreadable config must not leave a ghost owner blocking every other window.
      if (claimedHere && tutorialOwner === event.sender && tutorialLeaseGeneration === claimGeneration) {
        tutorialOwner = null;
        tutorialLeaseGeneration++;
        clearTutorialHandoff();
      }
      throw err;
    }
  });

  ipcMain.handle('tutorial:release', async (event, requested?: TutorialWindow) => {
    assertTutorialSender(event);
    if (requested !== undefined && requested !== 'home' && requested !== 'settings' && requested !== 'dependencies') {
      throw new Error('Invalid tutorial handoff target');
    }
    const changed = tutorialOwner === event.sender;
    if (changed) {
      tutorialOwner = null;
      tutorialLeaseGeneration++;
      setTutorialHandoff(requested ?? null);
    }
    const snapshot = await readTutorialSnapshot();
    if (changed) broadcastTutorial(snapshot);
    return snapshot;
  });

  ipcMain.handle('tutorial:transition', async (event, transition: TutorialTransition) => {
    assertTutorialSender(event);
    const admitted = tutorialOwner === event.sender && !event.sender.isDestroyed();
    const leaseGeneration = tutorialLeaseGeneration;
    const result = await updateTutorialProgress(
      transition,
      () => admitted && tutorialOwner === event.sender && tutorialLeaseGeneration === leaseGeneration && !event.sender.isDestroyed(),
    );
    const snapshot = tutorialSnapshot(result.progress);
    if (result.applied) broadcastTutorial(snapshot);
    return { applied: result.applied, snapshot };
  });

  ipcMain.handle('tutorial:set-enabled', async (event, enabled: unknown) => {
    if (assertTutorialSender(event) !== 'settings') throw new Error('The tutorial toggle belongs to Settings');
    if (typeof enabled !== 'boolean') throw new Error('Invalid tutorial toggle');
    const result = await setTutorialEnabled(enabled);
    if (result.applied) {
      // The old lease and any reserved handoff describe a tour this choice just replaced.
      tutorialOwner = null;
      tutorialLeaseGeneration++;
      clearTutorialHandoff();
    }
    const snapshot = tutorialSnapshot(result.progress);
    if (result.applied) broadcastTutorial(snapshot);
    return { applied: result.applied, snapshot };
  });

  ipcMain.on('workspace-monaco-unsaved-paths', (event, paths: unknown) => {
    if (!mainState.mainWindow || event.sender !== mainState.mainWindow.webContents) {
      return;
    }
    mainState.monacoWorkspaceUnsavedPaths = Array.isArray(paths)
      ? paths.filter((p): p is string => typeof p === 'string')
      : [];
  });

  ipcMain.handle('get-workspace-monaco-unsaved-paths', (event) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      return [];
    }
    return [...(mainState.monacoWorkspaceUnsavedPaths ?? [])];
  });

  ipcMain.handle(
    'patch-workspace-monaco-scroll',
    async (
      event,
      workspaceId: string,
      relativePath: string,
      scroll: WorkspaceMonacoEditorScrollState | null,
    ) => {
      try {
        assertTrustedMainRenderer(event);
      } catch {
        return;
      }
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

  ipcMain.handle(
    'patch-workspace-open-tabs',
    async (event, workspaceId: string, state: WorkspaceOpenTabsState | null) => {
      try {
        assertTrustedMainRenderer(event);
      } catch {
        return;
      }
      const wsId = typeof workspaceId === 'string' ? workspaceId.trim() : '';
      if (!wsId) {
        return;
      }
      const normalized = normalizeWorkspaceOpenTabsState(state);
      await updateConfig((cfg) => {
        const byWs = { ...(cfg.workspaceOpenTabsByWorkspaceId ?? {}) };
        if (!normalized.state) {
          delete byWs[wsId];
        } else {
          byWs[wsId] = normalized.state;
        }
        cfg.workspaceOpenTabsByWorkspaceId = byWs;
      });
    },
  );

  ipcMain.handle('get-recent-conversations', (event, limit: number) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      return [];
    }
    return getRecentConversations(limit);
  });

  ipcMain.handle('refresh-menu', (event) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      return;
    }
    buildMenu();
  });

  ipcMain.handle(
    'set-workspace-context',
    async (
      event,
      sessionId: string,
      workspacePath: string,
      workspaceContext: string,
      extras?: WorkspaceContextSyncExtras,
    ) => {
      try {
        assertTrustedMainRenderer(event);
      } catch {
        return;
      }
      await syncWorkspaceContextToPython(sessionId, workspacePath, workspaceContext, extras);
    },
  );

  ipcMain.handle('list-python-interpreters', async (event, sessionId: string) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      return {
        ok: false as const,
        error: 'Untrusted IPC sender',
        interpreters: [] as Array<{
          id: string;
          label: string;
          pythonExecutable: string;
          venvPath: string;
        }>,
        activeInterpreterId: null as string | null,
      };
    }
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
      event,
      payload: { workspaceId: string; sessionId: string; interpreterId: string },
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        assertTrustedMainRenderer(event);
      } catch {
        return { ok: false, error: 'Untrusted IPC sender' };
      }
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
    'ensure-workspace-system-prompt',
    async (event, workspaceId: string, sessionId?: string | null): Promise<EnsureWorkspaceSystemPromptResult> => {
      try {
        assertTrustedMainRenderer(event);
      } catch {
        return { ok: false, error: 'Untrusted IPC sender' };
      }
      const wid = typeof workspaceId === 'string' ? workspaceId.trim() : '';
      if (!wid) {
        return { ok: false, error: 'Workspace id is required.' };
      }
      const config = await loadConfig();
      const workspace = config.workspaces.find((w) => w.id === wid);
      if (!workspace?.path?.trim()) {
        return { ok: false, error: 'Workspace not found.' };
      }
      try {
        const result = await ensureWorkspaceSystemPrompt(workspace.path, workspace.id);
        await resyncActiveSessionSystemPrompt(workspace.path, workspace.id, sessionId);
        return {
          ok: true,
          absolutePath: result.absolutePath,
          relativePath: result.relativePath,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    },
  );

  ipcMain.handle('load-config', async (event) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return null;
    }
    const result = await reconcileLostWorkspaces();
    await publishLostWorkspaceReconcile(result);
    return result.config;
  });

  ipcMain.handle('save-config', async (event, config: AppConfig) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return null;
    }
    const saved = await updateConfig((disk) => mergeSettingsConfigSave(disk, config));
    // Disk write + UI broadcast first. Python /runtime-config can block for tens of
    // seconds (sidecar busy or 60s headers timeout) and was freezing Settings → Apply.
    setHealthMetricsEnabled(saved.healthMonitor.metricsEnabled);
    broadcastConfig(saved);
    applyScreenshotRetention(saved.workspaceTools.screenshotRetention);
    void applyPublishedConfigRuntime(saved).catch((err) => {
      console.error('Failed to apply saved config to runtime:', err);
    });
    return saved;
  });

  ipcMain.handle(
    'set-last-active-conversation',
    async (event, workspaceKey: string, conversationId: string) => {
      try {
        assertTrustedAppRenderer(event);
      } catch {
        return null;
      }
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

  ipcMain.handle('set-active-llm-model', async (event, modelId: string) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return null;
    }
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

  ipcMain.handle('patch-health-monitor', async (event, patch: Partial<HealthMonitorConfig>) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return null;
    }
    const config = await updateConfig((cfg) => {
      cfg.healthMonitor = { ...cfg.healthMonitor, ...patch };
    });
    await syncPythonLogLevel(config.healthMonitor.logLevel);
    setHealthMetricsEnabled(config.healthMonitor.metricsEnabled);
    broadcastConfig(config);
    return config;
  });

  /**
   * Client-only UI preference. Mutated on disk instead of round-tripping the renderer's whole
   * config, so a stale renderer snapshot cannot revert settings saved from another window.
   */
  ipcMain.handle('set-confirm-move', async (event, enabled: boolean) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return null;
    }
    const config = await updateConfig((cfg) => {
      cfg.confirmMove = enabled !== false;
    });
    broadcastConfig(config);
    return config;
  });

  ipcMain.handle('get-workspaces', async (event) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return [];
    }
    const result = await reconcileLostWorkspaces();
    await publishLostWorkspaceReconcile(result);
    return result.config.workspaces;
  });

  ipcMain.handle('add-workspace', async (event, name: string, workspacePath: string) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return null;
    }
    let workspace!: Workspace;
    const now = new Date().toISOString();
    const config = await updateConfig((cfg) => {
      workspace = {
        id: randomUUID(),
        name: name || path.basename(workspacePath) || 'New Workspace',
        path: workspacePath,
        createdAt: now,
        lastOpenedAt: now,
      };
      cfg.workspaces.push(workspace);
    });
    await ensureWorkspaceSystemPrompt(workspace.path, workspace.id).catch((err) => {
      console.warn('[system-prompt] Failed to seed workspace system prompt:', err);
    });
    await syncRuntimeConfigToPython(config, getLlamaManagedRuntimeOverrides(config));
    await refreshWorkspaceWatcherForCurrentConfig(config);
    broadcastConfig(config);
    buildMenu();
    return workspace;
  });

  ipcMain.handle('remove-workspace', async (event, id: string) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return;
    }
    const previousCurrent = (await loadConfig()).currentWorkspaceId;
    const config = await updateConfig((cfg) => {
      dropWorkspaceFromConfig(cfg, id);
    });
    await purgeWorkspacePersistedData(id);
    await publishLostWorkspaceReconcile({
      config,
      removedIds: [id],
      currentWorkspaceChanged: previousCurrent !== config.currentWorkspaceId,
    });
  });

  ipcMain.handle('set-current-workspace', async (event, id: string | null) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return;
    }
    const reconciled = await reconcileLostWorkspaces();
    await publishLostWorkspaceReconcile(reconciled);
    if (id && !reconciled.config.workspaces.some((workspace) => workspace.id === id)) {
      return;
    }
    if (id === reconciled.config.currentWorkspaceId) {
      return;
    }

    const now = new Date().toISOString();
    const config = await updateConfig((cfg) => {
      cfg.currentWorkspaceId = id;
      if (id) {
        cfg.workspaces = cfg.workspaces.map((w) => (w.id === id ? { ...w, lastOpenedAt: now } : w));
      }
    });
    await shutdownAllLspManagersBestEffort();
    await syncRuntimeConfigToPython(config, getLlamaManagedRuntimeOverrides(config));
    await refreshWorkspaceWatcherForCurrentConfig(config);
    sendToWindowIfAlive(mainState.mainWindow, 'workspace-changed', id);
    broadcastConfig(config);
    buildMenu();
  });

  ipcMain.handle('set-workspace-favorite', async (event, id: string, favorite: boolean) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return null;
    }
    if (typeof id !== 'string' || !id.trim() || typeof favorite !== 'boolean') {
      return null;
    }
    const config = await updateConfig((cfg) => {
      cfg.workspaces = setWorkspaceFavorite(cfg.workspaces, id, favorite);
    });
    broadcastConfig(config);
    buildMenu();
    return config;
  });

  ipcMain.handle('reorder-workspace-favorites', async (event, orderedIds: unknown) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return null;
    }
    if (!Array.isArray(orderedIds) || orderedIds.some((item) => typeof item !== 'string')) {
      return null;
    }
    const config = await updateConfig((cfg) => {
      cfg.workspaces = reorderFavoriteWorkspaces(cfg.workspaces, orderedIds as string[]);
    });
    broadcastConfig(config);
    buildMenu();
    return config;
  });

  ipcMain.handle('set-theme', async (event, themeId: string) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return null;
    }
    const config = await updateConfig((cfg) => {
      cfg.themeId = themeId || FIRST_THEME_ID;
    });
    await syncRuntimeConfigToPython(config, getLlamaManagedRuntimeOverrides(config));
    broadcastConfig(config);
    return config;
  });

  ipcMain.handle('get-current-workspace', async (event) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return null;
    }
    const result = await reconcileLostWorkspaces();
    await publishLostWorkspaceReconcile(result);
    if (!result.config.currentWorkspaceId) return null;
    return result.config.workspaces.find((w) => w.id === result.config.currentWorkspaceId) || null;
  });

  ipcMain.handle('set-always-on-top', (event, pinned: boolean) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      return;
    }
    mainState.mainWindow?.setAlwaysOnTop(pinned);
  });
}
