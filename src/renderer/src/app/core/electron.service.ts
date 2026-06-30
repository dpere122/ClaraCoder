/**
 * Bridges Angular to `window.electronAPI`: IPC invokes, and RxJS streams for push events from main.
 * Runs listener setup once in the constructor; all methods no-op or resolve empty when not in Electron.
 */
import { Injectable, NgZone } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { mergeStreamBatchQueue, type StreamBatchItem } from './stream-batch';
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
  HealthMonitorConfig,
  LspDashboardStatus,
  LlamaServerLifecycleEvent,
  LlamaServerOutputEvent,
  LlamaServerProcessExitEvent,
  LlamaServerStartResult,
  LlamaServerStatusResult,
  LlamacppManagedListModelsResult,
  LmStudioListModelsResult,
  LmStudioMutationResult,
  LlmStatus,
  ModelManagerDetectCachesResult,
  ModelManagerHfSearchResult,
  ModelManagerListModelsResult,
  ModelManagerMigrateProgressPayload,
  ModelManagerMutationResult,
  MaybeAutoTitleResult,
  PlanConfirmPayload,
  PlannerProgress,
  BuildPlanOpenPayload,
  StagedTransferBatchPayload,
  PythonInterpreterListItem,
  TtsStreamPacket,
  Workspace,
  WorkspaceContextSyncExtras,
  WorkspaceFileWriteOptions,
  WorkspaceFilesChangedMessage,
} from '@shared/index';
import { getDefaultContextCompression } from '@shared/index';

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
  outcome?: 'passed' | 'failed';
}

export interface DoneMessage {
  conversationId: string;
}

export interface LlmStatusMessage {
  conversationId: string;
  status: LlmStatus;
}

export interface HarnessCrystalMessage {
  conversationId: string;
  polarity: 'positive' | 'negative';
}

/** OpenAI-compatible usage from the backend (LangChain ``usage_metadata`` / SDK ``usage``). */
export interface LlmTokenUsageMessage {
  conversationId: string;
  inputTokens: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ContextCompressedMessage {
  conversationId: string;
  tokensBefore: number;
  tokensAfter: number;
  toolMessagesCompacted: number;
  toolRoundsDropped: number;
}

export interface DiffMessage {
  conversationId: string;
  diff: FileDiffPayload;
}

export interface StagedTransferBatchMessage {
  conversationId: string;
  payload: StagedTransferBatchPayload;
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

export interface PlanConfirmMessage {
  conversationId: string;
  payload: PlanConfirmPayload;
}

export interface PlannerProgressMessage {
  conversationId: string;
  planner: PlannerProgress;
}

export interface BuildPlanOpenMessage {
  conversationId: string;
  payload: BuildPlanOpenPayload;
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

export interface LspEditorIRangePayload {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface LspEditorLocationPayload {
  relativePath: string;
  range: LspEditorIRangePayload;
}

export interface LspEditorDocumentSymbolPayload {
  name: string;
  kind?: number;
  detail?: string;
  range: LspEditorIRangePayload;
  selectionRange: LspEditorIRangePayload;
  children?: LspEditorDocumentSymbolPayload[];
}

export interface LspEditorFlatSymbolPayload {
  name: string;
  kind?: number;
  containerName?: string;
  relativePath: string;
  range: LspEditorIRangePayload;
}

export interface LspEditorTextEditPayload {
  range: LspEditorIRangePayload;
  newText: string;
}

export interface LspEditorCompletionItemPayload {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { value: string; isTrusted?: boolean };
  filterText?: string;
  sortText?: string;
  insertText?: string;
  insertTextFormat?: number;
  textEdit?: LspEditorTextEditPayload;
  additionalTextEdits?: LspEditorTextEditPayload[];
}

export interface LspWorkspaceEditPayload {
  changes: Record<string, LspEditorTextEditPayload[]>;
}

export interface LspSemanticTokensLegendPayload {
  tokenTypes: string[];
  tokenModifiers: string[];
  supported: boolean;
}

export interface LspSemanticTokensFullPayload {
  legend: { tokenTypes: string[]; tokenModifiers: string[] };
  data: number[];
  resultId: string | null;
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
  private readonly harnessCrystalSubject = new Subject<HarnessCrystalMessage>();
  private readonly finalTextSubject = new Subject<{ conversationId: string; text: string }>();
  private readonly llmTokenUsageSubject = new Subject<LlmTokenUsageMessage>();
  private readonly contextCompressedSubject = new Subject<ContextCompressedMessage>();
  private readonly diffSubject = new Subject<DiffMessage>();
  private readonly stagedTransferBatchSubject = new Subject<StagedTransferBatchMessage>();
  private readonly acceptCommandSubject = new Subject<AcceptCommandMessage>();
  private readonly copyConfirmSubject = new Subject<CopyConfirmMessage>();
  private readonly deleteConfirmSubject = new Subject<DeleteConfirmMessage>();
  private readonly plannerProgressSubject = new Subject<PlannerProgressMessage>();
  private readonly buildPlanOpenSubject = new Subject<BuildPlanOpenMessage>();
  private readonly planConfirmSubject = new Subject<PlanConfirmMessage>();
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
  readonly harnessCrystal$ = this.harnessCrystalSubject.asObservable();
  /** Final assistant text (clean, without intermediate briefs) sent by the backend at stream end. */
  readonly finalText$ = this.finalTextSubject.asObservable();
  /** Per chat-model completion: measured prompt/completion/total tokens from the OpenAI-compatible API. */
  readonly llmTokenUsage$ = this.llmTokenUsageSubject.asObservable();
  readonly contextCompressed$ = this.contextCompressedSubject.asObservable();
  readonly diff$ = this.diffSubject.asObservable();
  readonly stagedTransferBatch$ = this.stagedTransferBatchSubject.asObservable();
  readonly acceptCommand$ = this.acceptCommandSubject.asObservable();
  readonly copyConfirm$ = this.copyConfirmSubject.asObservable();
  readonly deleteConfirm$ = this.deleteConfirmSubject.asObservable();
  readonly plannerProgress$ = this.plannerProgressSubject.asObservable();
  readonly buildPlanOpen$ = this.buildPlanOpenSubject.asObservable();
  readonly planConfirm$ = this.planConfirmSubject.asObservable();
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

  /** Coalesce high-frequency chat/tool stream IPC within one animation frame (ordering preserved). */
  private streamBatchQueue: StreamBatchItem[] = [];
  private streamBatchRaf: number | null = null;

  private enqueueStreamBatchItem(item: StreamBatchItem): void {
    this.streamBatchQueue.push(item);
    if (this.streamBatchRaf != null) {
      return;
    }
    this.streamBatchRaf = requestAnimationFrame(() => this.flushStreamBatch());
  }

  private flushStreamBatch(): void {
    this.streamBatchRaf = null;
    const raw = this.streamBatchQueue;
    this.streamBatchQueue = [];
    const merged = mergeStreamBatchQueue(raw);
    this.zone.run(() => {
      for (const item of merged) {
        if (item.kind === 'chunk') {
          this.chunkSubject.next(item.msg);
        } else if (item.kind === 'toolRead') {
          this.toolReadChunkSubject.next(item.msg);
        } else if (item.kind === 'toolExec') {
          this.toolExecChunkSubject.next(item.msg);
        } else {
          this.toolExecCompleteSubject.next(item.msg);
        }
      }
    });
  }

  private get api(): ElectronAPI | undefined {
    return window.electronAPI;
  }

  get isElectron(): boolean {
    return !!this.api;
  }

  constructor(private zone: NgZone) {
    this.api?.onMessageChunk((_event, conversationId, delta, streamTag) => {
      this.enqueueStreamBatchItem({ kind: 'chunk', msg: { conversationId, delta, streamTag } });
    });
    this.api?.onMessageToolReadChunk((_event, conversationId, delta) => {
      this.enqueueStreamBatchItem({ kind: 'toolRead', msg: { conversationId, delta } });
    });
    this.api?.onMessageToolExecChunk?.((_event, conversationId, delta, streamTag, label) => {
      this.enqueueStreamBatchItem({
        kind: 'toolExec',
        msg: { conversationId, delta, streamTag, label },
      });
    });
    this.api?.onMessageToolExecComplete?.(
      (_event, conversationId, streamTag, label, exitCode, outputExcerpt, outcome) => {
        this.enqueueStreamBatchItem({
          kind: 'toolExecComplete',
          msg: {
            conversationId,
            streamTag,
            label,
            exitCode,
            outputExcerpt,
            outcome,
          },
        });
      },
    );
    this.api?.onMessageDone((_event, conversationId) => {
      this.zone.run(() => this.doneSubject.next({ conversationId }));
    });
    this.api?.onMessageTokenUsage?.((_event, conversationId, usage) => {
      const u = usage && typeof usage === 'object' ? usage : {};
      const inputRaw = (u as { inputTokens?: unknown }).inputTokens;
      const inputTokens = typeof inputRaw === 'number' && Number.isFinite(inputRaw) ? inputRaw : 0;
      const outRaw = (u as { outputTokens?: unknown }).outputTokens;
      const totRaw = (u as { totalTokens?: unknown }).totalTokens;
      this.zone.run(() =>
        this.llmTokenUsageSubject.next({
          conversationId,
          inputTokens,
          ...(typeof outRaw === 'number' && Number.isFinite(outRaw) ? { outputTokens: outRaw } : {}),
          ...(typeof totRaw === 'number' && Number.isFinite(totRaw) ? { totalTokens: totRaw } : {}),
        }),
      );
    });
    this.api?.onMessageContextCompressed?.((_event, conversationId, payload) => {
      const p = payload && typeof payload === 'object' ? payload : {};
      const beforeRaw = (p as { tokensBefore?: unknown }).tokensBefore;
      const afterRaw = (p as { tokensAfter?: unknown }).tokensAfter;
      const compactedRaw = (p as { toolMessagesCompacted?: unknown }).toolMessagesCompacted;
      const droppedRaw = (p as { toolRoundsDropped?: unknown }).toolRoundsDropped;
      const tokensBefore = typeof beforeRaw === 'number' && Number.isFinite(beforeRaw) ? beforeRaw : 0;
      const tokensAfter = typeof afterRaw === 'number' && Number.isFinite(afterRaw) ? afterRaw : 0;
      const toolMessagesCompacted =
        typeof compactedRaw === 'number' && Number.isFinite(compactedRaw) ? compactedRaw : 0;
      const toolRoundsDropped =
        typeof droppedRaw === 'number' && Number.isFinite(droppedRaw) ? droppedRaw : 0;
      this.zone.run(() =>
        this.contextCompressedSubject.next({
          conversationId,
          tokensBefore,
          tokensAfter,
          toolMessagesCompacted,
          toolRoundsDropped,
        }),
      );
    });
    this.api?.onMessageStatus((_event, conversationId, status) => {
      this.zone.run(() => this.llmStatusSubject.next({ conversationId, status }));
    });
    this.api?.onMessageHarnessCrystal?.((_event, conversationId, polarity) => {
      this.zone.run(() =>
        this.harnessCrystalSubject.next({
          conversationId,
          polarity: polarity === 'negative' ? 'negative' : 'positive',
        }),
      );
    });
    this.api?.onMessageFinalText?.((_event, conversationId, text) => {
      this.zone.run(() => this.finalTextSubject.next({ conversationId, text }));
    });
    this.api?.onMessageDiff?.((_event, conversationId, diff) => {
      this.zone.run(() => this.diffSubject.next({ conversationId, diff }));
    });
    this.api?.onMessageStagedTransferBatch?.((_event, conversationId, payload) => {
      this.zone.run(() => this.stagedTransferBatchSubject.next({ conversationId, payload }));
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
    this.api?.onMessagePlannerProgress?.((_event, conversationId, planner) => {
      this.zone.run(() =>
        this.plannerProgressSubject.next({ conversationId, planner: planner as PlannerProgress }),
      );
    });
    this.api?.onMessageBuildPlanOpen?.((_event, conversationId, payload) => {
      this.zone.run(() =>
        this.buildPlanOpenSubject.next({
          conversationId,
          payload: payload as BuildPlanOpenPayload,
        }),
      );
    });
    this.api?.onMessagePlanConfirm?.((_event, conversationId, payload) => {
      this.zone.run(() =>
        this.planConfirmSubject.next({ conversationId, payload: payload as PlanConfirmPayload }),
      );
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
    workspaceId?: string | null,
    composerMode: 'agent' | 'plan' = 'agent',
  ): void {
    this.api?.sendMessage(
      conversationId,
      msg,
      applyMode,
      autoApplyMode,
      structuredContent ? [...structuredContent] : undefined,
      workspaceId ?? null,
      composerMode,
    );
  }

  abortMessage(conversationId: string): Promise<{ ok: boolean; error?: string }> {
    return (
      this.api?.abortMessage(conversationId) ??
      Promise.resolve({ ok: false, error: 'API not available' })
    );
  }

  cancelBuildPlan(conversationId: string, planId: string): Promise<{ ok: boolean; error?: string }> {
    return (
      this.api?.cancelBuildPlan(conversationId, planId) ??
      Promise.resolve({ ok: false, error: 'API not available' })
    );
  }

  getPendingStreamIdsForWorkspace(workspaceId: string | null): Promise<string[]> {
    return this.api?.getPendingStreamIdsForWorkspace(workspaceId) ?? Promise.resolve([]);
  }

  abortPendingStreamsForWorkspace(workspaceId: string | null): Promise<{ aborted: string[] }> {
    return (
      this.api?.abortPendingStreamsForWorkspace(workspaceId) ??
      Promise.resolve({ aborted: [] })
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
    stagedTransferRequestId?: string,
    stagedTransferPath?: string,
    planConfirmAction?: 'confirm' | 'cancel',
    planConfirmRequestId?: string,
  ): Promise<{ ok: boolean; error?: string; batchComplete?: boolean }> {
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
        stagedTransferRequestId,
        stagedTransferPath,
        planConfirmAction,
        planConfirmRequestId,
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

  createWorkspaceFile(
    workspaceRoot: string,
    absoluteParentDir: string,
    fileName: string,
  ): Promise<{ ok: boolean; path?: string; error?: string }> {
    return (
      this.api?.createWorkspaceFile?.(workspaceRoot, absoluteParentDir, fileName) ??
      Promise.resolve({ ok: false, error: 'API not available' })
    );
  }

  createWorkspaceFolder(
    workspaceRoot: string,
    absoluteParentDir: string,
    folderName: string,
  ): Promise<{ ok: boolean; path?: string; error?: string }> {
    return (
      this.api?.createWorkspaceFolder?.(workspaceRoot, absoluteParentDir, folderName) ??
      Promise.resolve({ ok: false, error: 'API not available' })
    );
  }

  deleteWorkspaceEntry(
    workspaceRoot: string,
    absolutePath: string,
  ): Promise<{ ok: boolean; path?: string; error?: string }> {
    return (
      this.api?.deleteWorkspaceEntry?.(workspaceRoot, absolutePath) ??
      Promise.resolve({ ok: false, error: 'API not available' })
    );
  }

  renameWorkspaceEntry(
    workspaceRoot: string,
    absolutePath: string,
    newName: string,
  ): Promise<{ ok: boolean; path?: string; error?: string }> {
    return (
      this.api?.renameWorkspaceEntry?.(workspaceRoot, absolutePath, newName) ??
      Promise.resolve({ ok: false, error: 'API not available' })
    );
  }

  moveWorkspaceEntry(
    workspaceRoot: string,
    sourceAbsolutePath: string,
    destParentAbsolutePath: string,
  ): Promise<{ ok: boolean; path?: string; error?: string }> {
    return (
      this.api?.moveWorkspaceEntry?.(workspaceRoot, sourceAbsolutePath, destParentAbsolutePath) ??
      Promise.resolve({ ok: false, error: 'API not available' })
    );
  }

  importPathsIntoWorkspace(
    workspaceRoot: string,
    destParentAbsolutePath: string,
    sourceAbsolutePaths: string[],
  ): Promise<{ ok: boolean; paths?: string[]; error?: string }> {
    return (
      this.api?.importPathsIntoWorkspace?.(workspaceRoot, destParentAbsolutePath, sourceAbsolutePaths) ??
      Promise.resolve({ ok: false, error: 'API not available' })
    );
  }

  readWorkspaceFile(
    workspaceRoot: string,
    relativePath: string,
  ): Promise<{ ok: boolean; content?: string; path?: string; error?: string }> {
    return (
      this.api?.readWorkspaceFile?.(workspaceRoot, relativePath) ??
      Promise.resolve({ ok: false, error: 'API not available' })
    );
  }

  readWorkspaceImageBase64(
    workspaceRoot: string,
    relativePath: string,
  ): Promise<{ ok: boolean; dataUrl?: string; mime?: string; path?: string; error?: string }> {
    return (
      this.api?.readWorkspaceImageBase64?.(workspaceRoot, relativePath) ??
      Promise.resolve({ ok: false, error: 'API not available' })
    );
  }

  workspaceFileExists(
    workspaceRoot: string,
    relativePath: string,
  ): Promise<{ ok: boolean; exists?: boolean; isFile?: boolean; error?: string }> {
    return (
      this.api?.workspaceFileExists?.(workspaceRoot, relativePath) ??
      Promise.resolve({ ok: false, error: 'API not available' })
    );
  }

  writeEditorDetachedSnapshot(content: string): Promise<{ ok: boolean; path?: string; error?: string }> {
    return (
      this.api?.writeEditorDetachedSnapshot?.(content) ??
      Promise.resolve({ ok: false, error: 'API not available' })
    );
  }

  deleteEditorDetachedSnapshot(absolutePath: string): Promise<{ ok: boolean; error?: string }> {
    return (
      this.api?.deleteEditorDetachedSnapshot?.(absolutePath) ??
      Promise.resolve({ ok: false, error: 'API not available' })
    );
  }

  promptSaveEditorFile(
    workspaceRoot: string,
    defaultRelativePath: string,
    content: string,
  ): Promise<{
    ok: boolean;
    cancelled?: boolean;
    absolutePath?: string;
    relativePath?: string;
    outsideWorkspace?: boolean;
    error?: string;
  }> {
    return (
      this.api?.promptSaveEditorFile?.(workspaceRoot, defaultRelativePath, content) ??
      Promise.resolve({ ok: false, error: 'API not available' })
    );
  }

  writeAbsoluteFile(
    absolutePath: string,
    content: string,
  ): Promise<{ ok: boolean; path?: string; error?: string }> {
    return (
      this.api?.writeAbsoluteFile?.(absolutePath, content) ??
      Promise.resolve({ ok: false, error: 'API not available' })
    );
  }

  readAbsoluteFile(
    absolutePath: string,
  ): Promise<{ ok: boolean; content?: string; path?: string; error?: string }> {
    return (
      this.api?.readAbsoluteFile?.(absolutePath) ??
      Promise.resolve({ ok: false, error: 'API not available' })
    );
  }

  setAlwaysOnTop(pinned: boolean): void {
    this.api?.setAlwaysOnTop(pinned);
  }

  getConversations(workspaceId?: string | null): Promise<ConversationMeta[]> {
    return this.api?.getConversations(workspaceId) ?? Promise.resolve([]);
  }

  readConversationFromDisk(id: string, workspaceId?: string | null): Promise<Conversation> {
    return this.api!.readConversationFromDisk(id, workspaceId);
  }

  loadConversation(
    id: string,
    workspaceId?: string | null,
    options?: { skipPythonResync?: boolean },
  ): Promise<Conversation> {
    return this.api!.loadConversation(id, workspaceId, options);
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

  maybeAutoTitleConversation(id: string): Promise<MaybeAutoTitleResult> {
    return (
      this.api?.maybeAutoTitleConversation?.(id) ??
      Promise.resolve({ ok: false, reason: 'fetch_failed' } as const)
    );
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

  getWorkspaceMonacoUnsavedPaths(): Promise<string[]> {
    return this.api?.getWorkspaceMonacoUnsavedPaths?.() ?? Promise.resolve([]);
  }

  reportWorkspaceMonacoUnsavedPaths(paths: readonly string[]): void {
    this.api?.reportWorkspaceMonacoUnsavedPaths?.([...paths]);
  }

  getCurrentWorkspace(): Promise<Workspace | null> {
    return this.api?.getCurrentWorkspace() ?? Promise.resolve(null);
  }

  async startTtsStreamRequest(text: string, voice: string, speed: number, seq: number): Promise<void> {
    await (this.api?.startTtsStream(text, voice, speed, seq) ?? Promise.resolve({ ok: true }));
  }

  registerTtsStreamUrl(text: string, voice: string, speed: number): Promise<{ url: string }> {
    return this.api?.registerTtsStreamUrl(text, voice, speed) ?? Promise.resolve({ url: '' });
  }

  abortTtsStream(): Promise<{ ok: boolean }> {
    return this.api?.abortTtsStream() ?? Promise.resolve({ ok: true });
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

  workspacePathIsDirectory(absolutePath: string): Promise<boolean> {
    return this.api?.workspacePathIsDirectory(absolutePath) ?? Promise.resolve(false);
  }

  modelManagerPickCustomDir(): Promise<string | null> {
    return this.api?.modelManagerPickCustomDir() ?? Promise.resolve(null);
  }

  modelManagerListCustomModels(payload: { customDir: string }): Promise<ModelManagerListModelsResult> {
    return (
      this.api?.modelManagerListCustomModels(payload) ?? Promise.resolve({ ok: false, error: 'API not available' })
    );
  }

  modelManagerDetectCaches(): Promise<ModelManagerDetectCachesResult> {
    return (
      this.api?.modelManagerDetectCaches() ?? Promise.resolve({ ok: false, error: 'API not available' })
    );
  }

  modelManagerListCacheCandidates(payload: { cachePaths: string[] }): Promise<ModelManagerListModelsResult> {
    return (
      this.api?.modelManagerListCacheCandidates(payload) ?? Promise.resolve({ ok: false, error: 'API not available' })
    );
  }

  modelManagerChooseMigrateMode(payload: { title?: string; detail?: string }): Promise<'copy' | 'move' | null> {
    return this.api?.modelManagerChooseMigrateMode(payload) ?? Promise.resolve(null);
  }

  subscribeModelManagerMigrateProgress(cb: (p: ModelManagerMigrateProgressPayload) => void): () => void {
    const wrapped = (p: ModelManagerMigrateProgressPayload) => this.zone.run(() => cb(p));
    return this.api?.modelManagerSubscribeMigrateProgress?.(wrapped) ?? (() => {});
  }

  modelManagerMigrateModel(payload: {
    sourcePath: string;
    customDir: string;
    mode: 'copy' | 'move';
    suggestedFileName?: string;
    entryKind?: 'file' | 'hubRepo';
  }): Promise<ModelManagerMutationResult> {
    return (
      this.api?.modelManagerMigrateModel(payload) ?? Promise.resolve({ ok: false, error: 'API not available' })
    );
  }

  modelManagerRenameModel(payload: {
    customDir: string;
    modelPath: string;
    newFileName: string;
  }): Promise<ModelManagerMutationResult> {
    return (
      this.api?.modelManagerRenameModel(payload) ?? Promise.resolve({ ok: false, error: 'API not available' })
    );
  }

  modelManagerDeleteModel(payload: { customDir: string; modelPath: string }): Promise<ModelManagerMutationResult> {
    return (
      this.api?.modelManagerDeleteModel(payload) ?? Promise.resolve({ ok: false, error: 'API not available' })
    );
  }

  modelManagerSearchHf(payload: { query: string; token?: string; limit?: number }): Promise<ModelManagerHfSearchResult> {
    return (
      this.api?.modelManagerSearchHf(payload) ?? Promise.resolve({ ok: false, error: 'API not available' })
    );
  }

  async setWorkspaceContext(
    sessionId: string,
    workspacePath: string,
    workspaceContext: string,
    extras?: WorkspaceContextSyncExtras,
  ): Promise<void> {
    await (this.api?.setWorkspaceContext?.(sessionId, workspacePath, workspaceContext, extras) ?? Promise.resolve());
  }

  listPythonInterpreters(
    sessionId: string,
  ): Promise<
    | { ok: true; interpreters: PythonInterpreterListItem[]; activeInterpreterId: string | null }
    | {
        ok: false;
        error: string;
        interpreters: PythonInterpreterListItem[];
        activeInterpreterId: string | null;
      }
  > {
    return (
      this.api?.listPythonInterpreters?.(sessionId) ??
      Promise.resolve({
        ok: false as const,
        error: 'API not available',
        interpreters: [],
        activeInterpreterId: null,
      })
    );
  }

  applyWorkspacePythonInterpreter(payload: {
    workspaceId: string;
    sessionId: string;
    interpreterId: string;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    return (
      this.api?.applyWorkspacePythonInterpreter?.(payload) ??
      Promise.resolve({ ok: false, error: 'API not available' })
    );
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
      activeLlmModelId: 'default-lmstudio',
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
        allowStagingOverlayCommands: false,
        exposeAllWorkspaceFiles: false,
      },
      contextCompression: getDefaultContextCompression(),
      healthMonitor: {
        logLevel: 'info',
        metricsEnabled: false,
      },
      modelManager: {
        customModelsDir: '',
        huggingFaceToken: '',
      },
      chatSidebarWidthPercent: 0.75,
    });
  }

  saveConfig(config: AppConfig): Promise<AppConfig> {
    return this.api?.saveConfig(config) ?? Promise.resolve(structuredClone(config));
  }

  setLastActiveConversation(workspaceKey: string, conversationId: string): Promise<AppConfig> {
    return (
      this.api?.setLastActiveConversation(workspaceKey, conversationId) ??
      Promise.resolve({
        currentWorkspaceId: null,
        workspaces: [],
        themeId: 'dark',
        noWorkspaceThemeId: 'dark',
        activeLlmModelId: 'default-lmstudio',
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
          allowStagingOverlayCommands: false,
          exposeAllWorkspaceFiles: false,
        },
        contextCompression: getDefaultContextCompression(),
        healthMonitor: {
          logLevel: 'info',
          metricsEnabled: false,
        },
        modelManager: {
          customModelsDir: '',
          huggingFaceToken: '',
        },
      })
    );
  }

  setActiveLlmModel(modelId: string): Promise<AppConfig> {
    return this.api?.setActiveLlmModel(modelId) ?? Promise.resolve({
      currentWorkspaceId: null,
      workspaces: [],
      themeId: 'dark',
      noWorkspaceThemeId: 'dark',
      activeLlmModelId: modelId,
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
        allowStagingOverlayCommands: false,
        exposeAllWorkspaceFiles: false,
      },
      contextCompression: getDefaultContextCompression(),
      healthMonitor: {
        logLevel: 'info',
        metricsEnabled: false,
      },
      modelManager: {
        customModelsDir: '',
        huggingFaceToken: '',
      },
    });
  }

  patchHealthMonitor(patch: Partial<HealthMonitorConfig>): Promise<AppConfig> {
    return (
      this.api?.patchHealthMonitor(patch) ??
      Promise.resolve({
        currentWorkspaceId: null,
        workspaces: [],
        themeId: 'dark',
        noWorkspaceThemeId: 'dark',
        activeLlmModelId: 'default-lmstudio',
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
          allowStagingOverlayCommands: false,
          exposeAllWorkspaceFiles: false,
        },
        contextCompression: getDefaultContextCompression(),
        healthMonitor: {
          logLevel: 'info',
          metricsEnabled: false,
          ...patch,
        },
        modelManager: {
          customModelsDir: '',
          huggingFaceToken: '',
        },
      })
    );
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

  llamacppManagedListModels(payload: {
    modelId: string;
    config: AppConfig;
  }): Promise<LlamacppManagedListModelsResult> {
    return (
      this.api?.llamacppManagedListModels(payload) ?? Promise.resolve({ ok: false, error: 'API not available' })
    );
  }

  llamacppOpenAiListModels(payload: { baseUrl: string; apiKey: string }): Promise<LlamacppManagedListModelsResult> {
    return (
      this.api?.llamacppOpenAiListModels(payload) ?? Promise.resolve({ ok: false, error: 'API not available' })
    );
  }

  lmStudioListModels(payload: { baseUrl: string; apiKey?: string }): Promise<LmStudioListModelsResult> {
    return this.api?.lmStudioListModels(payload) ?? Promise.resolve({ ok: false, error: 'API not available' });
  }

  lmStudioLoadModel(payload: { baseUrl: string; model: string; apiKey?: string }): Promise<LmStudioMutationResult> {
    return this.api?.lmStudioLoadModel(payload) ?? Promise.resolve({ ok: false, error: 'API not available' });
  }

  lmStudioUnloadModel(payload: {
    baseUrl: string;
    instanceId: string;
    apiKey?: string;
  }): Promise<LmStudioMutationResult> {
    return this.api?.lmStudioUnloadModel(payload) ?? Promise.resolve({ ok: false, error: 'API not available' });
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
    workspaceRoot: string,
    cwd: string,
    cols: number,
    rows: number,
  ): Promise<{ success: true; sessionId: string } | { success: false; error: string }> {
    return (
      this.api?.workspacePtySpawn(workspaceRoot, cwd, cols, rows) ??
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

  getLspDashboardStatus(
    sessionId: string,
  ): Promise<{ ok: true; status: LspDashboardStatus } | { ok: false; error: string }> {
    return (
      this.api?.getLspDashboardStatus?.(sessionId) ??
      Promise.resolve({ ok: false as const, error: 'API not available' })
    );
  }

  /** Starts LSP if needed and opens/syncs the file from disk (Python ``/lsp/diagnostics`` warm path). */
  warmLspForActiveFile(
    sessionId: string,
    relativePath: string,
    encoding?: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return (
      this.api?.warmLspForActiveFile?.(sessionId, relativePath, encoding) ??
      Promise.resolve({ ok: false as const, error: 'API not available' })
    );
  }

  /** Start the given LSP subprocess if needed (``POST /lsp/warm-server``; no document open). */
  warmLspServer(sessionId: string, server: string): Promise<{ ok: true } | { ok: false; error: string }> {
    return (
      this.api?.warmLspServer?.(sessionId, server) ?? Promise.resolve({ ok: false as const, error: 'API not available' })
    );
  }

  /** Workspace Monaco hover via Python ``POST /lsp/hover`` (1-based line/column). */
  lspEditorHover(
    sessionId: string,
    relativePath: string,
    line: number,
    character: number,
    documentText: string,
    skipDocumentSync?: boolean,
  ): Promise<{ ok: true; markdown: string | null } | { ok: false; error: string }> {
    return (
      this.api?.lspEditorHover?.(sessionId, relativePath, line, character, documentText, skipDocumentSync === true) ??
      Promise.resolve({ ok: false as const, error: 'API not available' })
    );
  }

  lspEditorDefinition(
    sessionId: string,
    relativePath: string,
    line: number,
    character: number,
    documentText: string,
    skipDocumentSync?: boolean,
  ): Promise<
    | { ok: true; locations: LspEditorLocationPayload[] }
    | { ok: false; error: string }
  > {
    return (
      this.api?.lspEditorDefinition?.(
        sessionId,
        relativePath,
        line,
        character,
        documentText,
        skipDocumentSync === true,
      ) ?? Promise.resolve({ ok: false as const, error: 'API not available' })
    );
  }

  lspEditorReferences(
    sessionId: string,
    relativePath: string,
    line: number,
    character: number,
    documentText: string,
    includeDeclaration: boolean,
    skipDocumentSync?: boolean,
  ): Promise<
    | { ok: true; locations: LspEditorLocationPayload[] }
    | { ok: false; error: string }
  > {
    return (
      this.api?.lspEditorReferences?.(
        sessionId,
        relativePath,
        line,
        character,
        documentText,
        includeDeclaration,
        skipDocumentSync === true,
      ) ?? Promise.resolve({ ok: false as const, error: 'API not available' })
    );
  }

  lspEditorDocumentSymbols(
    sessionId: string,
    relativePath: string,
    documentText: string,
    skipDocumentSync?: boolean,
  ): Promise<
    | {
        ok: true;
        hierarchical: LspEditorDocumentSymbolPayload[];
        flat: LspEditorFlatSymbolPayload[];
      }
    | { ok: false; error: string }
  > {
    return (
      this.api?.lspEditorDocumentSymbols?.(sessionId, relativePath, documentText, skipDocumentSync === true) ??
      Promise.resolve({ ok: false as const, error: 'API not available' })
    );
  }

  lspEditorCompletion(
    sessionId: string,
    relativePath: string,
    line: number,
    character: number,
    documentText: string,
    triggerKind: number,
    triggerCharacter: string | null,
    skipDocumentSync?: boolean,
  ): Promise<
    | { ok: true; isIncomplete: boolean; items: LspEditorCompletionItemPayload[] }
    | { ok: false; error: string }
  > {
    return (
      this.api?.lspEditorCompletion?.(
        sessionId,
        relativePath,
        line,
        character,
        documentText,
        triggerKind,
        triggerCharacter,
        skipDocumentSync === true,
      ) ?? Promise.resolve({ ok: false as const, error: 'API not available' })
    );
  }

  lspEditorRename(
    sessionId: string,
    relativePath: string,
    line: number,
    character: number,
    documentText: string,
    newName: string,
    skipDocumentSync?: boolean,
  ): Promise<
    | { ok: true; workspaceEdit: LspWorkspaceEditPayload | null }
    | { ok: false; error: string }
  > {
    return (
      this.api?.lspEditorRename?.(
        sessionId,
        relativePath,
        line,
        character,
        documentText,
        newName,
        skipDocumentSync === true,
      ) ?? Promise.resolve({ ok: false as const, error: 'API not available' })
    );
  }

  lspEditorSemanticTokensLegend(
    sessionId: string,
    server: string,
  ): Promise<{ ok: true; legend: LspSemanticTokensLegendPayload } | { ok: false; error: string }> {
    return (
      this.api?.lspEditorSemanticTokensLegend?.(sessionId, server) ??
      Promise.resolve({ ok: false as const, error: 'API not available' })
    );
  }

  lspEditorSemanticTokensFull(
    sessionId: string,
    relativePath: string,
    documentText: string,
    skipDocumentSync?: boolean,
  ): Promise<{ ok: true; payload: LspSemanticTokensFullPayload } | { ok: false; error: string }> {
    return (
      this.api?.lspEditorSemanticTokensFull?.(sessionId, relativePath, documentText, skipDocumentSync === true) ??
      Promise.resolve({ ok: false as const, error: 'API not available' })
    );
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
