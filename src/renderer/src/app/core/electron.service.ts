/**
 * Bridges Angular to `window.electronAPI`: IPC invokes, and RxJS streams for push events from main.
 * Runs listener setup once in the constructor; all methods no-op or resolve empty when not in Electron.
 */
import { Injectable, NgZone } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import type {
  AcceptCommandPayload,
  AppConfig,
  ChatStructuredContentPart,
  Conversation,
  ConversationMeta,
  CopyConfirmPayload,
  DeleteConfirmPayload,
  FileDiffPayload,
  FileEntry,
  HealthLogRecord,
  HealthMetricsSnapshot,
  LlamaServerLifecycleEvent,
  LlamaServerOutputEvent,
  LlamaServerProcessExitEvent,
  LlamaServerStartResult,
  LlamaServerStatusResult,
  LlmStatus,
  PlannerProgress,
  TtsStreamPacket,
  Workspace,
  WorkspaceContextSyncExtras,
  WorkspaceFileWriteOptions,
  WorkspaceFilesChangedMessage,
} from '@shared/index';

export interface ChunkMessage {
  conversationId: string;
  delta: string;
  streamTag?: string;
}

/** Read-tool output mirrored from the backend (not part of the saved assistant reply). */
export interface ToolReadChunkMessage {
  conversationId: string;
  delta: string;
}

export interface ToolExecChunkMessage {
  conversationId: string;
  delta: string;
  streamTag?: string;
  label?: string;
}

export interface ToolExecCompleteMessage {
  conversationId: string;
  streamTag?: string;
  label?: string;
  exitCode?: number | null;
  outputExcerpt?: string;
}

export interface DoneMessage {
  conversationId: string;
}

export interface LlmStatusMessage {
  conversationId: string;
  status: LlmStatus;
}

export interface PlannerMessage {
  conversationId: string;
  planner: PlannerProgress;
}

export interface DiffMessage {
  conversationId: string;
  diff: FileDiffPayload;
}

export interface AcceptCommandMessage {
  conversationId: string;
  payload: AcceptCommandPayload;
}

export interface CopyConfirmMessage {
  conversationId: string;
  payload: CopyConfirmPayload;
}

export interface DeleteConfirmMessage {
  conversationId: string;
  payload: DeleteConfirmPayload;
}

export interface ScriptOutputMessage {
  processId: string;
  type: 'stdout' | 'stderr' | 'error';
  data: string;
}

export interface ScriptCompleteMessage {
  processId: string;
  exitCode: number | null;
}

export interface WorkspacePtyDataMessage {
  sessionId: string;
  data: string;
}

export interface WorkspacePtyExitMessage {
  sessionId: string;
  exitCode: number;
  signal: number | null;
}

export interface ConversationWorkspaceChangedMessage {
  id: string;
  workspacePath: string;
}

@Injectable({ providedIn: 'root' })
export class ElectronService {
  private static ttsPacketListenerWired = false;

  private readonly chunkSubject = new Subject<ChunkMessage>();
  private readonly toolReadChunkSubject = new Subject<ToolReadChunkMessage>();
  private readonly toolExecChunkSubject = new Subject<ToolExecChunkMessage>();
  private readonly toolExecCompleteSubject = new Subject<ToolExecCompleteMessage>();
  private readonly doneSubject = new Subject<DoneMessage>();
  private readonly llmStatusSubject = new Subject<LlmStatusMessage>();
  private readonly plannerSubject = new Subject<PlannerMessage>();
  private readonly diffSubject = new Subject<DiffMessage>();
  private readonly acceptCommandSubject = new Subject<AcceptCommandMessage>();
  private readonly copyConfirmSubject = new Subject<CopyConfirmMessage>();
  private readonly deleteConfirmSubject = new Subject<DeleteConfirmMessage>();
  private readonly configSubject = new Subject<AppConfig>();
  private readonly settingsWindowVisibilitySubject = new Subject<boolean>();
  private readonly activeConversationChangedSubject = new Subject<string | null>();
  private readonly conversationWorkspaceChangedSubject = new Subject<ConversationWorkspaceChangedMessage>();
  private readonly workspaceChangedSubject = new Subject<string | null>();
  private readonly workspaceFilesChangedSubject = new Subject<WorkspaceFilesChangedMessage>();
  private readonly openWorkspaceSubject = new Subject<string>();
  private readonly openConversationSubject = new Subject<string>();
  private readonly scriptOutputSubject = new Subject<ScriptOutputMessage>();
  private readonly scriptCompleteSubject = new Subject<ScriptCompleteMessage>();
  private readonly workspacePtyDataSubject = new Subject<WorkspacePtyDataMessage>();
  private readonly workspacePtyExitSubject = new Subject<WorkspacePtyExitMessage>();
  private readonly llamaServerOutputSubject = new Subject<LlamaServerOutputEvent>();
  private readonly llamaServerProcessExitSubject = new Subject<LlamaServerProcessExitEvent>();
  private readonly llamaServerLifecycleSubject = new Subject<LlamaServerLifecycleEvent>();
  private readonly ttsStreamSubject = new Subject<TtsStreamPacket>();
  private readonly healthLogRecordSubject = new Subject<HealthLogRecord>();
  private readonly windowMaximizedSubject = new Subject<boolean>();
  /** Emits when the main BrowserWindow is maximized or restored (frameless chrome). */
  readonly windowMaximized$ = this.windowMaximizedSubject.asObservable();
  readonly chunk$ = this.chunkSubject.asObservable();
  readonly toolReadChunk$ = this.toolReadChunkSubject.asObservable();
  readonly toolExecChunk$ = this.toolExecChunkSubject.asObservable();
  readonly toolExecComplete$ = this.toolExecCompleteSubject.asObservable();
  readonly done$ = this.doneSubject.asObservable();
  readonly llmStatus$ = this.llmStatusSubject.asObservable();
  readonly planner$ = this.plannerSubject.asObservable();
  readonly diff$ = this.diffSubject.asObservable();
  readonly acceptCommand$ = this.acceptCommandSubject.asObservable();
  readonly copyConfirm$ = this.copyConfirmSubject.asObservable();
  readonly deleteConfirm$ = this.deleteConfirmSubject.asObservable();
  readonly config$ = this.configSubject.asObservable();
  readonly settingsWindowVisibility$ = this.settingsWindowVisibilitySubject.asObservable();
  readonly activeConversationChanged$ = this.activeConversationChangedSubject.asObservable();
  readonly conversationWorkspaceChanged$ = this.conversationWorkspaceChangedSubject.asObservable();
  readonly workspaceChanged$ = this.workspaceChangedSubject.asObservable();
  readonly workspaceFilesChanged$ = this.workspaceFilesChangedSubject.asObservable();
  readonly openWorkspace$ = this.openWorkspaceSubject.asObservable();
  readonly openConversation$ = this.openConversationSubject.asObservable();
  readonly scriptOutput$ = this.scriptOutputSubject.asObservable();
  readonly scriptComplete$ = this.scriptCompleteSubject.asObservable();
  readonly workspacePtyData$ = this.workspacePtyDataSubject.asObservable();
  readonly workspacePtyExit$ = this.workspacePtyExitSubject.asObservable();
  readonly llamaServerOutput$ = this.llamaServerOutputSubject.asObservable();
  readonly llamaServerProcessExit$ = this.llamaServerProcessExitSubject.asObservable();
  readonly llamaServerLifecycle$ = this.llamaServerLifecycleSubject.asObservable();
  /** TTS MP3 packets from the main process (filter by `seq` in the app). */
  readonly ttsStream$: Observable<TtsStreamPacket> = this.ttsStreamSubject.asObservable();
  readonly healthLogRecord$ = this.healthLogRecordSubject.asObservable();

  private get api(): ElectronAPI | undefined {
    return window.electronAPI;
  }

  get isElectron(): boolean {
    return !!this.api;
  }

  constructor(private zone: NgZone) {
    this.api?.onMessageChunk((_event, conversationId, delta, streamTag) => {
      this.zone.run(() => this.chunkSubject.next({ conversationId, delta, streamTag }));
    });
    this.api?.onMessageToolReadChunk((_event, conversationId, delta) => {
      this.zone.run(() => this.toolReadChunkSubject.next({ conversationId, delta }));
    });
    this.api?.onMessageToolExecChunk?.((_event, conversationId, delta, streamTag, label) => {
      this.zone.run(() => this.toolExecChunkSubject.next({ conversationId, delta, streamTag, label }));
    });
    this.api?.onMessageToolExecComplete?.(
      (_event, conversationId, streamTag, label, exitCode, outputExcerpt) => {
        this.zone.run(() =>
          this.toolExecCompleteSubject.next({
            conversationId,
            streamTag,
            label,
            exitCode,
            outputExcerpt,
          }),
        );
      },
    );
    this.api?.onMessageDone((_event, conversationId) => {
      this.zone.run(() => this.doneSubject.next({ conversationId }));
    });
    this.api?.onMessageStatus((_event, conversationId, status) => {
      this.zone.run(() => this.llmStatusSubject.next({ conversationId, status }));
    });
    this.api?.onMessagePlanner?.((_event, conversationId, planner) => {
      this.zone.run(() => this.plannerSubject.next({ conversationId, planner }));
    });
    this.api?.onMessageDiff?.((_event, conversationId, diff) => {
      this.zone.run(() => this.diffSubject.next({ conversationId, diff }));
    });
    this.api?.onMessageAcceptCommand?.((_event, conversationId, payload) => {
      this.zone.run(() => this.acceptCommandSubject.next({ conversationId, payload }));
    });
    this.api?.onMessageCopyConfirm?.((_event, conversationId, payload) => {
      this.zone.run(() => this.copyConfirmSubject.next({ conversationId, payload }));
    });
    this.api?.onMessageDeleteConfirm?.((_event, conversationId, payload) => {
      this.zone.run(() => this.deleteConfirmSubject.next({ conversationId, payload }));
    });
    this.api?.onConfigUpdated((_event, config) => {
      this.zone.run(() => this.configSubject.next(config));
    });
    this.api?.onSettingsWindowVisibilityChanged((_event, isOpen) => {
      this.zone.run(() => this.settingsWindowVisibilitySubject.next(isOpen));
    });
    this.api?.onActiveConversationChanged((_event, conversationId) => {
      this.zone.run(() => this.activeConversationChangedSubject.next(conversationId));
    });
    this.api?.onConversationWorkspaceChanged((_event, data) => {
      this.zone.run(() => this.conversationWorkspaceChangedSubject.next(data));
    });
    this.api?.onWorkspaceChanged((_event, workspaceId) => {
      this.zone.run(() => this.workspaceChangedSubject.next(workspaceId));
    });
    this.api?.onWorkspaceFilesChanged((_event, data) => {
      this.zone.run(() => this.workspaceFilesChangedSubject.next(data));
    });
    this.api?.onOpenWorkspace((_event, workspacePath) => {
      this.zone.run(() => this.openWorkspaceSubject.next(workspacePath));
    });
    this.api?.onOpenConversation((_event, conversationId) => {
      this.zone.run(() => this.openConversationSubject.next(conversationId));
    });
    this.api?.onScriptOutput((_event, data) => {
      this.zone.run(() => this.scriptOutputSubject.next(data));
    });
    this.api?.onScriptComplete((_event, data) => {
      this.zone.run(() => this.scriptCompleteSubject.next(data));
    });
    this.api?.onWorkspacePtyData?.((_event, data) => {
      this.zone.run(() => this.workspacePtyDataSubject.next(data));
    });
    this.api?.onWorkspacePtyExit?.((_event, data) => {
      this.zone.run(() => this.workspacePtyExitSubject.next(data));
    });
    this.api?.onLlamaServerOutput?.((_event, data) => {
      this.zone.run(() => this.llamaServerOutputSubject.next(data as LlamaServerOutputEvent));
    });
    this.api?.onLlamaServerProcessExit?.((_event, data) => {
      this.zone.run(() => this.llamaServerProcessExitSubject.next(data as LlamaServerProcessExitEvent));
    });
    this.api?.onLlamaServerLifecycle?.((_event, data) => {
      this.zone.run(() => this.llamaServerLifecycleSubject.next(data as LlamaServerLifecycleEvent));
    });
    if (!ElectronService.ttsPacketListenerWired && this.api?.onTtsStreamPacket) {
      ElectronService.ttsPacketListenerWired = true;
      this.api.onTtsStreamPacket((packet) => {
        this.zone.run(() => this.ttsStreamSubject.next(packet));
      });
    }
    this.api?.onHealthLogRecord?.((_event, record) => {
      this.zone.run(() => this.healthLogRecordSubject.next(record));
    });
    this.api?.onWindowMaximizedChanged?.((maximized) => {
      this.zone.run(() => this.windowMaximizedSubject.next(maximized));
    });
    this.api?.onReady();
  }

  sendMessage(
    conversationId: string,
    msg: string,
    applyMode = true,
    autoApplyMode = false,
    structuredContent?: readonly ChatStructuredContentPart[],
  ): void {
    this.api?.sendMessage(
      conversationId,
      msg,
      applyMode,
      autoApplyMode,
      structuredContent ? [...structuredContent] : undefined,
    );
  }

  abortMessage(conversationId: string): Promise<{ ok: boolean; error?: string }> {
    return (
      this.api?.abortMessage(conversationId) ??
      Promise.resolve({ ok: false, error: 'API not available' })
    );
  }

  /** Resume the in-flight LangChain stream after diff, delete, or copy confirmation. */
  notifyAgentContinue(
    conversationId: string,
    note: string,
    deleteAction?: 'confirm' | 'cancel',
    deleteRequestId?: string,
    copyAction?: 'confirm' | 'cancel',
    copyRequestId?: string,
    acceptCommandAction?: 'confirm' | 'cancel',
    acceptCommandRequestId?: string,
    stagedTransferAction?: 'confirm' | 're_review',
  ): Promise<{ ok: boolean; error?: string }> {
    return (
      this.api?.agentContinue(
        conversationId,
        note,
        deleteAction,
        deleteRequestId,
        copyAction,
        copyRequestId,
        acceptCommandAction,
        acceptCommandRequestId,
        stagedTransferAction,
      ) ??
      Promise.resolve({ ok: false, error: 'API not available' })
    );
  }

  /** Push toolbar auto-apply to Python so mid-stream toggles affect the next tool call. */
  syncAutoApplyMode(conversationId: string, autoApplyMode: boolean): Promise<{ ok: boolean; error?: string }> {
    return (
      this.api?.syncAutoApplyMode(conversationId, autoApplyMode) ??
      Promise.resolve({ ok: false, error: 'API not available' })
    );
  }

  writeWorkspaceFile(
    workspaceRoot: string,
    relativePath: string,
    content: string,
    options?: WorkspaceFileWriteOptions,
  ): Promise<{ ok: boolean; path?: string; error?: string }> {
    return (
      this.api?.writeWorkspaceFile?.(workspaceRoot, relativePath, content, options) ??
      Promise.resolve({ ok: false, error: 'API not available' })
    );
  }

  setAlwaysOnTop(pinned: boolean): void {
    this.api?.setAlwaysOnTop(pinned);
  }

  getConversations(workspaceId?: string | null): Promise<ConversationMeta[]> {
    return this.api?.getConversations(workspaceId) ?? Promise.resolve([]);
  }

  loadConversation(id: string, workspaceId?: string | null): Promise<Conversation> {
    return this.api!.loadConversation(id, workspaceId);
  }

  saveConversation(conv: Conversation): Promise<void> {
    return this.api?.saveConversation(conv) ?? Promise.resolve();
  }

  deleteConversation(id: string, workspaceId?: string | null): Promise<void> {
    return this.api?.deleteConversation(id, workspaceId) ?? Promise.resolve();
  }

  renameConversation(id: string, title: string, workspaceId?: string | null): Promise<void> {
    return this.api?.renameConversation(id, title, workspaceId) ?? Promise.resolve();
  }

  newConversation(workspaceId: string | null): Promise<Conversation> {
    return this.api!.newConversation(workspaceId);
  }

  getWorkspaces(): Promise<Workspace[]> {
    return this.api?.getWorkspaces() ?? Promise.resolve([]);
  }

  addWorkspace(name: string, path: string): Promise<Workspace> {
    return this.api!.addWorkspace(name, path);
  }

  removeWorkspace(id: string): Promise<void> {
    return this.api?.removeWorkspace(id) ?? Promise.resolve();
  }

  setCurrentWorkspace(id: string | null): Promise<void> {
    return this.api?.setCurrentWorkspace(id) ?? Promise.resolve();
  }

  getCurrentWorkspace(): Promise<Workspace | null> {
    return this.api?.getCurrentWorkspace() ?? Promise.resolve(null);
  }

  async startTtsStreamRequest(text: string, voice: string, seq: number): Promise<void> {
    await (this.api?.startTtsStream(text, voice, seq) ?? Promise.resolve({ ok: true }));
  }

  registerTtsStreamUrl(text: string, voice: string): Promise<{ url: string }> {
    return this.api?.registerTtsStreamUrl(text, voice) ?? Promise.resolve({ url: '' });
  }

  abortTtsStream(): void {
    void this.api?.abortTtsStream();
  }

  transcribe(audio: ArrayBuffer): Promise<string> {
    return this.api!.transcribe(audio);
  }

  openDirectoryDialog(): Promise<string | null> {
    return this.api?.openDirectoryDialog() ?? Promise.resolve(null);
  }

  readDirectory(dirPath: string): Promise<FileEntry[]> {
    return this.api?.readDirectory(dirPath) ?? Promise.resolve([]);
  }

  readDirectoryRecursive(dirPath: string): Promise<string> {
    return this.api?.readDirectoryRecursive(dirPath) ?? Promise.resolve('');
  }

  async setWorkspaceContext(
    sessionId: string,
    workspacePath: string,
    workspaceContext: string,
    extras?: WorkspaceContextSyncExtras,
  ): Promise<void> {
    await (this.api?.setWorkspaceContext?.(sessionId, workspacePath, workspaceContext, extras) ?? Promise.resolve());
  }

  setConversationTheme(id: string, themeId: string): Promise<void> {
    return this.api?.setConversationTheme(id, themeId) ?? Promise.resolve();
  }

  setWorkspaceTheme(workspaceId: string, themeId: string): Promise<void> {
    return this.api?.setWorkspaceTheme(workspaceId, themeId) ?? Promise.resolve();
  }

  setNoWorkspaceTheme(themeId: string): Promise<void> {
    return this.api?.setNoWorkspaceTheme(themeId) ?? Promise.resolve();
  }

  getActiveConversationId(): Promise<string | null> {
    return this.api?.getActiveConversationId() ?? Promise.resolve(null);
  }

  loadConfig(): Promise<AppConfig> {
    return this.api?.loadConfig() ?? Promise.resolve({
      currentWorkspaceId: null,
      workspaces: [],
      themeId: 'dark',
      noWorkspaceThemeId: 'dark',
      activeLlmModelId: 'default-openai',
      llmProviders: [],
      audioTranscription: {
        provider: 'openai',
        baseUrl: '',
        model: 'gpt-4o-mini-transcribe',
        apiKey: '',
      },
      workspaceTools: {
        editToolsMode: 'standard',
        maxFileReadLines: 400,
        maxSearchResults: 40,
        defaultWorkspaceEncoding: 'utf-8',
        defaultWorkspaceNewline: 'lf',
        orchestratedMode: false,
      },
      healthMonitor: {
        logLevel: 'info',
        metricsEnabled: false,
      },
    });
  }

  saveConfig(config: AppConfig): Promise<AppConfig> {
    return this.api?.saveConfig(config) ?? Promise.resolve(structuredClone(config));
  }

  llamaServerStart(payload: { modelId: string; config: AppConfig }): Promise<LlamaServerStartResult> {
    return this.api?.llamaServerStart(payload) ?? Promise.resolve({ ok: false, error: 'API not available' });
  }

  llamaServerStop(payload: { modelId: string; config: AppConfig }): Promise<{ ok: true }> {
    return this.api?.llamaServerStop(payload) ?? Promise.resolve({ ok: true });
  }

  llamaServerStatus(payload: { modelId: string; config: AppConfig }): Promise<LlamaServerStatusResult> {
    return this.api?.llamaServerStatus(payload) ?? Promise.resolve({ ok: false, error: 'API not available' });
  }

  closeSettingsWindow(): void {
    this.api?.closeSettingsWindow();
  }

  runScript(script: string, language: string, workspacePath: string): Promise<{ stdout: string; stderr: string; exitCode?: number }> {
    return this.api?.runScript(script, language, workspacePath) ?? Promise.resolve({ stdout: '', stderr: 'API not available' });
  }

  runScriptInteractive(script: string, language: string, workspacePath: string): Promise<{ processId: string | null; success: boolean; error?: string }> {
    return this.api?.runScriptInteractive(script, language, workspacePath) ?? Promise.resolve({ processId: null, success: false, error: 'API not available' });
  }

  sendScriptInput(processId: string, input: string): Promise<{ success: boolean; error?: string }> {
    return this.api?.sendScriptInput(processId, input) ?? Promise.resolve({ success: false, error: 'API not available' });
  }

  endScript(processId: string): Promise<{ success: boolean; error?: string }> {
    return this.api?.endScript(processId) ?? Promise.resolve({ success: false, error: 'API not available' });
  }

  workspacePtySpawn(
    cwd: string,
    cols: number,
    rows: number,
  ): Promise<{ success: true; sessionId: string } | { success: false; error: string }> {
    return (
      this.api?.workspacePtySpawn(cwd, cols, rows) ??
      Promise.resolve({ success: false as const, error: 'API not available' })
    );
  }

  workspacePtyWrite(sessionId: string, data: string): Promise<{ success: boolean; error?: string }> {
    return this.api?.workspacePtyWrite(sessionId, data) ?? Promise.resolve({ success: false, error: 'API not available' });
  }

  workspacePtyResize(sessionId: string, cols: number, rows: number): Promise<{ success: boolean; error?: string }> {
    return (
      this.api?.workspacePtyResize(sessionId, cols, rows) ??
      Promise.resolve({ success: false, error: 'API not available' })
    );
  }

  workspacePtyKill(sessionId: string): Promise<{ success: boolean; error?: string }> {
    return this.api?.workspacePtyKill(sessionId) ?? Promise.resolve({ success: false, error: 'API not available' });
  }

  workspacePtyKillAll(): Promise<{ success: boolean }> {
    return this.api?.workspacePtyKillAll() ?? Promise.resolve({ success: false });
  }

  healthMetrics(): Promise<HealthMetricsSnapshot | null> {
    return this.api?.healthMetrics() ?? Promise.resolve(null);
  }

  healthLogsRecent(limit: number): Promise<HealthLogRecord[]> {
    return this.api?.healthLogsRecent(limit).then((r) => r.records) ?? Promise.resolve([]);
  }

  healthSetLogLevel(level: string): Promise<void> {
    return (this.api?.healthSetLogLevel(level) ?? Promise.resolve({ ok: true })).then(() => undefined);
  }

  healthLogsSubscribe(): void {
    this.api?.healthLogsSubscribe();
  }

  healthLogsUnsubscribe(): void {
    this.api?.healthLogsUnsubscribe();
  }

  closeHealthWindow(): void {
    this.api?.closeHealthWindow();
  }

  popupFileMenu(x: number, y: number): Promise<void> {
    return this.api?.popupFileMenu(x, y) ?? Promise.resolve();
  }

  popupHelpMenu(x: number, y: number): Promise<void> {
    return this.api?.popupHelpMenu(x, y) ?? Promise.resolve();
  }

  windowMinimize(): void {
    this.api?.windowMinimize();
  }

  windowToggleMaximize(): void {
    this.api?.windowToggleMaximize();
  }

  windowClose(): void {
    this.api?.windowClose();
  }

  windowIsMaximized(): Promise<boolean> {
    return this.api?.windowIsMaximized() ?? Promise.resolve(false);
  }
}
