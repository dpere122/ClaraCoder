/**
 * Bridges Angular to `window.electronAPI`: IPC invokes, and RxJS streams for push events from main.
 * Runs listener setup once in the constructor; all methods no-op or resolve empty when not in Electron.
 */
import { Injectable, NgZone } from '@angular/core';
import { Observable, Subject, BehaviorSubject } from 'rxjs';
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
  RuntimeHealthSnapshot,
  CudaGpuDevice,
  LspDashboardStatus,
  LlamaServerLifecycleEvent,
  LlamaServerOutputEvent,
  LlamaServerProcessExitEvent,
  LlamaServerStartResult,
  LlamaServerStatusResult,
  LlamacppManagedListModelsResult,
  ChatTemplateReasoningCaps,
  LmStudioListModelsResult,
  LmStudioMutationResult,
  LlmStatus,
  ModelManagerHfFilesResult,
  ModelManagerHfSearchResult,
  ModelManagerListModelsResult,
  ModelManagerMutationResult,
  ModelManagerDownloadHfResult,
  HfDownloadId,
  HfDownloadProgressEvent,
  MaybeAutoTitleResult,
  PlanConfirmPayload,
  AgentQuestionPayload,
  PlannerProgress,
  BuildPlanChunkPayload,
  BuildPlanOpenPayload,
  BuildPlanStreamEndPayload,
  StagedTransferBatchPayload,
  PythonInterpreterListItem,
  SystemFontInfo,
  TtsStreamPacket,
  Workspace,
  WorkspaceContextSyncExtras,
  WorkspaceFileWriteOptions,
  WorkspaceFilesChangedMessage,
  WorkspaceSystemPromptMutationResult,
  WorkspaceSystemPromptStatus,
} from '@shared/index';
import { getDefaultContextCompression, SecretValue } from '@shared/index';

/** Shape returned when `window.electronAPI` is unavailable (e.g. browser preview outside Electron). */
const FALLBACK_APP_CONFIG: AppConfig = {
  currentWorkspaceId: null,
  workspaces: [],
  themeId: 'woodland',
  activeLlmModelId: 'default-lmstudio',
  llmProviders: [],
  audioTranscription: {
    provider: 'whisper',
    baseUrl: '',
    model: 'small',
    apiKey: SecretValue.of(''),
  },
  workspaceTools: {
    editToolsMode: 'standard',
    maxFileReadLines: 400,
    maxSearchResults: 40,
    defaultWorkspaceEncoding: 'utf-8',
    defaultWorkspaceNewline: 'lf',
    allowStagingOverlayCommands: false,
    exposeAllWorkspaceFiles: false,
    allowWebAccess: false,
    searxngBaseUrl: '',
  },
  contextCompression: getDefaultContextCompression(),
  healthMonitor: {
    logLevel: 'info',
    metricsEnabled: false,
  },
  modelManager: {
    customModelsDir: '',
    huggingFaceToken: SecretValue.of(''),
  },
  chatSidebarWidthPercent: 1 / 3,
};

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

export interface BackgroundCommandOpenMessage {
  conversationId: string;
  commandId: string;
  commandText: string;
  cwdLabel: string;
  label: string;
  streamTag: string;
}

export type ChatStreamOutcome = 'completed' | 'aborted' | 'error';

export interface DoneMessage {
  conversationId: string;
  /** Aligns with Python history commit (COMPLETED-only); default completed when omitted. */
  outcome: ChatStreamOutcome;
}

export interface LlmStatusMessage {
  conversationId: string;
  status: LlmStatus;
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

export interface AgentQuestionMessage {
  conversationId: string;
  payload: AgentQuestionPayload;
}

export interface PlannerProgressMessage {
  conversationId: string;
  planner: PlannerProgress;
}

export interface BuildPlanOpenMessage {
  conversationId: string;
  payload: BuildPlanOpenPayload;
}

export interface BuildPlanChunkMessage {
  conversationId: string;
  payload: BuildPlanChunkPayload;
}

export interface BuildPlanStreamEndMessage {
  conversationId: string;
  payload: BuildPlanStreamEndPayload;
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

export interface WorkspacePtyCwdMessage {
  sessionId: string;
  cwd: string;
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

export interface LspEditorDiagnosticPayload {
  relative_path: string;
  message: string;
  severity: string;
  severity_value: number;
  code: string;
  source: string;
  line: number;
  character: number;
  end_line: number;
  end_character: number;
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
  private readonly backgroundCommandOpenSubject = new Subject<BackgroundCommandOpenMessage>();
  private readonly doneSubject = new Subject<DoneMessage>();
  private readonly llmStatusSubject = new Subject<LlmStatusMessage>();
  private readonly finalTextSubject = new Subject<{ conversationId: string; text: string }>();
  private readonly clearPrimaryStreamSubject = new Subject<{ conversationId: string }>();
  private readonly llmTokenUsageSubject = new Subject<LlmTokenUsageMessage>();
  private readonly contextCompressedSubject = new Subject<ContextCompressedMessage>();
  private readonly diffSubject = new Subject<DiffMessage>();
  private readonly stagedTransferBatchSubject = new Subject<StagedTransferBatchMessage>();
  private readonly acceptCommandSubject = new Subject<AcceptCommandMessage>();
  private readonly copyConfirmSubject = new Subject<CopyConfirmMessage>();
  private readonly deleteConfirmSubject = new Subject<DeleteConfirmMessage>();
  private readonly plannerProgressSubject = new Subject<PlannerProgressMessage>();
  private readonly buildPlanOpenSubject = new Subject<BuildPlanOpenMessage>();
  private readonly buildPlanChunkSubject = new Subject<BuildPlanChunkMessage>();
  private readonly buildPlanStreamEndSubject = new Subject<BuildPlanStreamEndMessage>();
  private readonly planConfirmSubject = new Subject<PlanConfirmMessage>();
  private readonly agentQuestionSubject = new Subject<AgentQuestionMessage>();
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
  private readonly workspacePtyCwdSubject = new Subject<WorkspacePtyCwdMessage>();
  private readonly llamaServerOutputSubject = new Subject<LlamaServerOutputEvent>();
  private readonly llamaServerProcessExitSubject = new Subject<LlamaServerProcessExitEvent>();
  private readonly llamaServerLifecycleSubject = new Subject<LlamaServerLifecycleEvent>();
  private readonly chatTemplateReasoningSubject = new BehaviorSubject<
    Readonly<Record<string, ChatTemplateReasoningCaps>>
  >({});
  private readonly llamaServerNctxSubject = new BehaviorSubject<Readonly<Record<string, number>>>({});
  private readonly hfDownloadProgressSubject = new Subject<HfDownloadProgressEvent>();
  private readonly ttsStreamSubject = new Subject<TtsStreamPacket>();
  private readonly healthLogRecordSubject = new Subject<HealthLogRecord>();
  private readonly windowMaximizedSubject = new Subject<boolean>();
  private readonly editorFindRequestedSubject = new Subject<void>();
  /** Emits when the main BrowserWindow is maximized or restored (frameless chrome). */
  readonly windowMaximized$ = this.windowMaximizedSubject.asObservable();
  /** Main intercepted Ctrl/Cmd+F; open Monaco find when a file editor is active. */
  readonly editorFindRequested$ = this.editorFindRequestedSubject.asObservable();
  readonly chunk$ = this.chunkSubject.asObservable();
  readonly toolReadChunk$ = this.toolReadChunkSubject.asObservable();
  readonly toolExecChunk$ = this.toolExecChunkSubject.asObservable();
  readonly toolExecComplete$ = this.toolExecCompleteSubject.asObservable();
  readonly backgroundCommandOpen$ = this.backgroundCommandOpenSubject.asObservable();
  readonly done$ = this.doneSubject.asObservable();
  readonly llmStatus$ = this.llmStatusSubject.asObservable();
  /** Final assistant text (clean, without intermediate briefs) sent by the backend at stream end. */
  readonly finalText$ = this.finalTextSubject.asObservable();
  /** Drop live primary agent prose when a model step ends with tool calls. */
  readonly clearPrimaryStream$ = this.clearPrimaryStreamSubject.asObservable();
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
  readonly buildPlanChunk$ = this.buildPlanChunkSubject.asObservable();
  readonly buildPlanStreamEnd$ = this.buildPlanStreamEndSubject.asObservable();
  readonly planConfirm$ = this.planConfirmSubject.asObservable();
  readonly agentQuestion$ = this.agentQuestionSubject.asObservable();
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
  readonly workspacePtyCwd$ = this.workspacePtyCwdSubject.asObservable();
  readonly llamaServerOutput$ = this.llamaServerOutputSubject.asObservable();
  readonly llamaServerProcessExit$ = this.llamaServerProcessExitSubject.asObservable();
  readonly llamaServerLifecycle$ = this.llamaServerLifecycleSubject.asObservable();
  /** Live Jinja reasoning caps keyed by model preset id (from ``GET /props``). */
  readonly chatTemplateReasoning$ = this.chatTemplateReasoningSubject.asObservable();
  /** Loaded llama-server ``n_ctx`` keyed by model preset id (from ``GET /props``). */
  readonly llamaServerNctx$ = this.llamaServerNctxSubject.asObservable();
  /** Hugging Face GGUF download progress events (queued/progress/done/error/cancelled). */
  readonly hfDownloadProgress$ = this.hfDownloadProgressSubject.asObservable();
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
    this.api?.onMessageBackgroundCommandOpen?.((_event, conversationId, payload) => {
      const p = payload && typeof payload === 'object' ? payload : {};
      const commandId = typeof (p as { commandId?: unknown }).commandId === 'string'
        ? (p as { commandId: string }).commandId
        : '';
      if (!commandId.trim()) {
        return;
      }
      this.zone.run(() =>
        this.backgroundCommandOpenSubject.next({
          conversationId,
          commandId: commandId.trim(),
          commandText: typeof (p as { commandText?: unknown }).commandText === 'string'
            ? (p as { commandText: string }).commandText
            : '',
          cwdLabel: typeof (p as { cwdLabel?: unknown }).cwdLabel === 'string'
            ? (p as { cwdLabel: string }).cwdLabel
            : '',
          label: typeof (p as { label?: unknown }).label === 'string'
            ? (p as { label: string }).label
            : commandId.trim(),
          streamTag: typeof (p as { streamTag?: unknown }).streamTag === 'string'
            ? (p as { streamTag: string }).streamTag
            : '',
        }),
      );
    });
    this.api?.onMessageDone((_event, conversationId, outcome) => {
      const resolved: ChatStreamOutcome =
        outcome === 'aborted' || outcome === 'error' || outcome === 'completed' ? outcome : 'completed';
      this.zone.run(() => this.doneSubject.next({ conversationId, outcome: resolved }));
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
    this.api?.onMessageFinalText?.((_event, conversationId, text) => {
      this.zone.run(() => this.finalTextSubject.next({ conversationId, text }));
    });
    this.api?.onMessageClearPrimaryStream?.((_event, conversationId) => {
      this.zone.run(() => this.clearPrimaryStreamSubject.next({ conversationId }));
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
    this.api?.onMessageBuildPlanChunk?.((_event, conversationId, payload) => {
      this.zone.run(() =>
        this.buildPlanChunkSubject.next({
          conversationId,
          payload: payload as BuildPlanChunkPayload,
        }),
      );
    });
    this.api?.onMessageBuildPlanStreamEnd?.((_event, conversationId, payload) => {
      this.zone.run(() =>
        this.buildPlanStreamEndSubject.next({
          conversationId,
          payload: payload as BuildPlanStreamEndPayload,
        }),
      );
    });
    this.api?.onMessagePlanConfirm?.((_event, conversationId, payload) => {
      this.zone.run(() =>
        this.planConfirmSubject.next({ conversationId, payload: payload as PlanConfirmPayload }),
      );
    });
    this.api?.onMessageAgentQuestion?.((_event, conversationId, payload) => {
      this.zone.run(() =>
        this.agentQuestionSubject.next({ conversationId, payload: payload as AgentQuestionPayload }),
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
    this.api?.onWorkspacePtyCwd?.((_event, data) => {
      this.zone.run(() => this.workspacePtyCwdSubject.next(data));
    });
    this.api?.onLlamaServerOutput?.((_event, data) => {
      this.zone.run(() => this.llamaServerOutputSubject.next(data as LlamaServerOutputEvent));
    });
    this.api?.onLlamaServerProcessExit?.((_event, data) => {
      this.zone.run(() => this.llamaServerProcessExitSubject.next(data as LlamaServerProcessExitEvent));
    });
    this.api?.onLlamaServerLifecycle?.((_event, data) => {
      this.zone.run(() => {
        const ev = data as LlamaServerLifecycleEvent;
        if (ev.phase === 'running') {
          if (ev.chatTemplateReasoning) {
            this.patchChatTemplateReasoning(ev.modelId, ev.chatTemplateReasoning);
          }
          this.patchLlamaServerNctx(ev.modelId, ev.nCtx);
        } else if (ev.phase === 'stopped') {
          this.patchChatTemplateReasoning(ev.modelId, undefined);
          this.patchLlamaServerNctx(ev.modelId, undefined);
        }
        this.llamaServerLifecycleSubject.next(ev);
      });
    });
    this.api?.onModelManagerHfDownloadProgress?.((_event, data) => {
      this.zone.run(() => this.hfDownloadProgressSubject.next(data as HfDownloadProgressEvent));
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
    this.api?.onEditorFindRequested?.(() => {
      this.zone.run(() => this.editorFindRequestedSubject.next());
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
    speechEnabled = false,
  ): void {
    this.api?.sendMessage(
      conversationId,
      msg,
      applyMode,
      autoApplyMode,
      structuredContent ? [...structuredContent] : undefined,
      workspaceId ?? null,
      composerMode,
      speechEnabled,
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

  notifyBackgroundCommandTerminalClosed(
    conversationId: string,
    commandId: string,
  ): Promise<{ ok: boolean; error?: string; detail?: string }> {
    return (
      this.api?.backgroundCommandTerminalClosed(conversationId, commandId) ??
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

  /** Submit (or cancel) answers to a plan-mode clarifying-questions HITL card. */
  notifyAgentQuestionAnswers(
    conversationId: string,
    action: 'submit' | 'cancel',
    requestId: string,
    answers: { questionId: string; optionId?: string; otherText?: string }[] = [],
  ): Promise<{ ok: boolean; error?: string }> {
    return (
      this.api?.agentQuestionAnswers(conversationId, action, requestId, answers) ??
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

  async startTtsStreamRequest(
    text: string,
    voice: string,
    speed: number,
    seq: number,
    instructions?: string,
  ): Promise<void> {
    await (
      this.api?.startTtsStream(text, voice, speed, seq, instructions) ?? Promise.resolve({ ok: true })
    );
  }

  registerTtsStreamUrl(
    text: string,
    voice: string,
    speed: number,
    instructions?: string,
  ): Promise<{ url: string }> {
    return this.api?.registerTtsStreamUrl(text, voice, speed, instructions) ?? Promise.resolve({ url: '' });
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

  openFileDialog(options?: { filters?: { name: string; extensions: string[] }[] }): Promise<string | null> {
    return this.api?.openFileDialog(options) ?? Promise.resolve(null);
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

  showWorkspacePathInFileManager(absolutePath: string): Promise<{ ok: boolean; error?: string }> {
    return (
      this.api?.showWorkspacePathInFileManager?.(absolutePath) ??
      Promise.resolve({ ok: false, error: 'API not available' })
    );
  }

  modelManagerPickCustomDir(): Promise<string | null> {
    return this.api?.modelManagerPickCustomDir() ?? Promise.resolve(null);
  }

  modelManagerListCustomModels(payload: { customDir: string }): Promise<ModelManagerListModelsResult> {
    return (
      this.api?.modelManagerListCustomModels(payload) ?? Promise.resolve({ ok: false, error: 'API not available' })
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

  modelManagerSearchHf(payload: {
    query: string;
    token?: string;
    limit?: number;
    skip?: number;
    fileType?: string;
  }): Promise<ModelManagerHfSearchResult> {
    return (
      this.api?.modelManagerSearchHf(payload) ??
      Promise.resolve({ ok: false, error: 'API not available' })
    );
  }

  modelManagerListHfFiles(payload: { id: string; token?: string }): Promise<ModelManagerHfFilesResult> {
    return (
      this.api?.modelManagerListHfFiles(payload) ??
      Promise.resolve({ ok: false, error: 'API not available' })
    );
  }

  modelManagerDownloadHfFile(payload: {
    repoId: string;
    fileName: string;
    customDir: string;
    token?: string;
  }): Promise<ModelManagerDownloadHfResult> {
    return (
      this.api?.modelManagerDownloadHfFile(payload) ??
      Promise.resolve({ ok: false, error: 'API not available' })
    );
  }

  modelManagerCancelHfDownload(payload: { downloadId: HfDownloadId }): Promise<{ ok: true } | { ok: false; error: string }> {
    return (
      this.api?.modelManagerCancelHfDownload(payload) ?? Promise.resolve({ ok: false, error: 'API not available' })
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

  getWorkspaceSystemPromptStatus(workspaceId: string): Promise<WorkspaceSystemPromptStatus> {
    return (
      this.api?.getWorkspaceSystemPromptStatus?.(workspaceId) ??
      Promise.resolve({ hasFile: false, sourceName: '' })
    );
  }

  pickWorkspaceSystemPrompt(
    workspaceId: string,
    sessionId?: string | null,
  ): Promise<WorkspaceSystemPromptMutationResult> {
    return (
      this.api?.pickWorkspaceSystemPrompt?.(workspaceId, sessionId) ??
      Promise.resolve({ ok: false, error: 'API not available', hasFile: false, sourceName: '' })
    );
  }

  getWorkspaceSystemPromptText(
    workspaceId: string,
  ): Promise<{ ok: true; text: string } | { ok: false; error: string; text: string }> {
    return (
      this.api?.getWorkspaceSystemPromptText?.(workspaceId) ??
      Promise.resolve({ ok: false, error: 'API not available', text: '' })
    );
  }

  saveWorkspaceSystemPromptText(payload: {
    workspaceId: string;
    text: string;
    sessionId?: string | null;
  }): Promise<WorkspaceSystemPromptMutationResult> {
    return (
      this.api?.saveWorkspaceSystemPromptText?.(payload) ??
      Promise.resolve({ ok: false, error: 'API not available', hasFile: false, sourceName: '' })
    );
  }

  clearWorkspaceSystemPrompt(
    workspaceId: string,
    sessionId?: string | null,
  ): Promise<WorkspaceSystemPromptMutationResult> {
    return (
      this.api?.clearWorkspaceSystemPrompt?.(workspaceId, sessionId) ??
      Promise.resolve({ ok: false, error: 'API not available', hasFile: false, sourceName: '' })
    );
  }

  setConversationTheme(id: string, themeId: string): Promise<void> {
    return this.api?.setConversationTheme(id, themeId) ?? Promise.resolve();
  }

  /** App-wide UI theme (single `AppConfig.themeId`, no per-workspace override). */
  setTheme(themeId: string): Promise<AppConfig> {
    return this.api?.setTheme(themeId) ?? Promise.resolve(structuredClone(FALLBACK_APP_CONFIG));
  }

  getActiveConversationId(): Promise<string | null> {
    return this.api?.getActiveConversationId() ?? Promise.resolve(null);
  }

  loadConfig(): Promise<AppConfig> {
    return this.api?.loadConfig() ?? Promise.resolve(structuredClone(FALLBACK_APP_CONFIG));
  }

  saveConfig(config: AppConfig): Promise<AppConfig> {
    return this.api?.saveConfig(config) ?? Promise.resolve(structuredClone(config));
  }

  setLastActiveConversation(workspaceKey: string, conversationId: string): Promise<AppConfig> {
    return (
      this.api?.setLastActiveConversation(workspaceKey, conversationId) ??
      Promise.resolve(structuredClone(FALLBACK_APP_CONFIG))
    );
  }

  patchWorkspaceMonacoScroll(
    workspaceId: string,
    relativePath: string,
    scroll: { scrollTop: number; scrollLeft: number } | null,
  ): Promise<void> {
    return this.api?.patchWorkspaceMonacoScroll(workspaceId, relativePath, scroll) ?? Promise.resolve();
  }

  setActiveLlmModel(modelId: string): Promise<AppConfig> {
    return (
      this.api?.setActiveLlmModel(modelId) ??
      Promise.resolve({ ...structuredClone(FALLBACK_APP_CONFIG), activeLlmModelId: modelId })
    );
  }

  patchHealthMonitor(patch: Partial<HealthMonitorConfig>): Promise<AppConfig> {
    return (
      this.api?.patchHealthMonitor(patch) ??
      Promise.resolve({
        ...structuredClone(FALLBACK_APP_CONFIG),
        healthMonitor: { ...FALLBACK_APP_CONFIG.healthMonitor, ...patch },
      })
    );
  }

  llamaServerStart(payload: { modelId: string; config: AppConfig }): Promise<LlamaServerStartResult> {
    return this.api?.llamaServerStart(payload) ?? Promise.resolve({ ok: false, error: 'API not available' });
  }

  llamaServerStop(payload: { modelId: string; config: AppConfig }): Promise<{ ok: true }> {
    return this.api?.llamaServerStop(payload) ?? Promise.resolve({ ok: true });
  }

  async llamaServerStatus(payload: { modelId: string; config: AppConfig }): Promise<LlamaServerStatusResult> {
    const result =
      (await this.api?.llamaServerStatus(payload)) ?? ({ ok: false, error: 'API not available' } as const);
    if (result.ok) {
      this.ingestStatusReasoning(result);
    }
    return result;
  }

  async refreshChatTemplateReasoning(modelId: string): Promise<ChatTemplateReasoningCaps | null> {
    const id = modelId.trim();
    if (!id) {
      return null;
    }
    const result = await this.api?.llamaServerChatTemplateReasoning({ modelId: id });
    if (!result || !result.ok) {
      return this.chatTemplateReasoningSubject.value[id] ?? null;
    }
    this.patchChatTemplateReasoning(id, result.chatTemplateReasoning ?? undefined);
    this.patchLlamaServerNctx(id, result.nCtx ?? undefined);
    return result.chatTemplateReasoning;
  }

  private ingestStatusReasoning(result: Extract<LlamaServerStatusResult, { ok: true }>): void {
    if (result.chatTemplateReasoning) {
      this.patchChatTemplateReasoning(result.modelId, result.chatTemplateReasoning);
    } else if (!result.starting && (result.chat.health === 'stopped' || result.chat.health === 'error')) {
      this.patchChatTemplateReasoning(result.modelId, undefined);
    }
    if (result.nCtx != null && result.nCtx > 0) {
      this.patchLlamaServerNctx(result.modelId, result.nCtx);
    } else if (!result.starting && (result.chat.health === 'stopped' || result.chat.health === 'error')) {
      this.patchLlamaServerNctx(result.modelId, undefined);
    }
  }

  private patchChatTemplateReasoning(modelId: string, caps: ChatTemplateReasoningCaps | undefined): void {
    const prev = this.chatTemplateReasoningSubject.value;
    if (!caps) {
      if (!(modelId in prev)) {
        return;
      }
      const next = { ...prev };
      delete next[modelId];
      this.chatTemplateReasoningSubject.next(next);
      return;
    }
    this.chatTemplateReasoningSubject.next({ ...prev, [modelId]: caps });
  }

  private patchLlamaServerNctx(modelId: string, nCtx: number | undefined): void {
    const prev = this.llamaServerNctxSubject.value;
    if (nCtx == null || nCtx < 1) {
      if (!(modelId in prev)) {
        return;
      }
      const next = { ...prev };
      delete next[modelId];
      this.llamaServerNctxSubject.next(next);
      return;
    }
    if (prev[modelId] === nCtx) {
      return;
    }
    this.llamaServerNctxSubject.next({ ...prev, [modelId]: nCtx });
  }

  /** Overlay a live context window (llama.cpp ``n_ctx`` or LM Studio loaded context) for the context meter. */
  applyLiveContextWindow(modelId: string, nCtx: number | null | undefined): void {
    this.patchLlamaServerNctx(modelId, nCtx != null && nCtx > 0 ? nCtx : undefined);
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

  openSettingsWindow(): void {
    this.api?.openSettingsWindow();
  }

  closeSettingsWindow(): void {
    this.api?.closeSettingsWindow();
  }

  openHealthWindow(): void {
    this.api?.openHealthWindow();
  }

  openDocumentation(): void {
    this.api?.openDocumentation();
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

  workspacePtyWrite(sessionId: string, data: string): void {
    this.api?.workspacePtyWrite(sessionId, data);
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

  listCudaGpus(): Promise<CudaGpuDevice[]> {
    return this.api?.listCudaGpus?.() ?? Promise.resolve([]);
  }

  healthRuntimeSnapshot(): Promise<RuntimeHealthSnapshot | null> {
    return this.api?.healthRuntimeSnapshot?.() ?? Promise.resolve(null);
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
  ): Promise<{ ok: true; markdown: string | null; range?: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number } | null; syncedFromDisk?: boolean } | { ok: false; error: string }> {
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

  lspEditorDiagnostics(
    sessionId: string,
    relativePath: string,
    documentText: string,
    skipDocumentSync?: boolean,
  ): Promise<
    | { ok: true; diagnostics: import('@shared/index').LspEditorDiagnostic[]; generation: number }
    | { ok: false; error: string }
  > {
    return (
      this.api?.lspEditorDiagnostics?.(sessionId, relativePath, documentText, skipDocumentSync === true) ??
      Promise.resolve({ ok: false as const, error: 'API not available' })
    );
  }

  lspDiagnosticsGeneration(
    sessionId: string,
    relativePath: string,
  ): Promise<{ ok: true; generation: number; count: number } | { ok: false; error: string }> {
    return (
      this.api?.lspDiagnosticsGeneration?.(sessionId, relativePath) ??
      Promise.resolve({ ok: false as const, error: 'API not available' })
    );
  }

  lspEditorSignatureHelp(
    sessionId: string,
    relativePath: string,
    line: number,
    character: number,
    documentText: string,
    triggerCharacter: string | null,
    isRetrigger: boolean,
    skipDocumentSync?: boolean,
  ): Promise<{ ok: true; signatureHelp: Record<string, unknown> | null } | { ok: false; error: string }> {
    return (
      this.api?.lspEditorSignatureHelp?.(
        sessionId,
        relativePath,
        line,
        character,
        documentText,
        triggerCharacter,
        isRetrigger,
        skipDocumentSync === true,
      ) ?? Promise.resolve({ ok: false as const, error: 'API not available' })
    );
  }

  lspEditorDocumentHighlight(
    sessionId: string,
    relativePath: string,
    line: number,
    character: number,
    documentText: string,
    skipDocumentSync?: boolean,
  ): Promise<{ ok: true; highlights: Array<{ range: LspEditorIRangePayload; kind?: number }> } | { ok: false; error: string }> {
    return (
      this.api?.lspEditorDocumentHighlight?.(
        sessionId,
        relativePath,
        line,
        character,
        documentText,
        skipDocumentSync === true,
      ) ?? Promise.resolve({ ok: false as const, error: 'API not available' })
    );
  }

  lspEditorCompletionResolve(
    sessionId: string,
    relativePath: string,
    item: Record<string, unknown>,
  ): Promise<{ ok: true; item: LspEditorCompletionItemPayload } | { ok: false; error: string }> {
    return (
      this.api?.lspEditorCompletionResolve?.(sessionId, relativePath, item) ??
      Promise.resolve({ ok: false as const, error: 'API not available' })
    );
  }

  lspEditorCodeAction(
    sessionId: string,
    relativePath: string,
    startLine: number,
    startCharacter: number,
    endLine: number,
    endCharacter: number,
    documentText: string,
    diagnostics: import('@shared/index').LspEditorDiagnostic[],
    skipDocumentSync?: boolean,
  ): Promise<
    | { ok: true; actions: Array<{ title: string; kind: string; isPreferred?: boolean; edit?: LspWorkspaceEditPayload }> }
    | { ok: false; error: string }
  > {
    return (
      this.api?.lspEditorCodeAction?.(
        sessionId,
        relativePath,
        startLine,
        startCharacter,
        endLine,
        endCharacter,
        documentText,
        diagnostics,
        skipDocumentSync === true,
      ) ?? Promise.resolve({ ok: false as const, error: 'API not available' })
    );
  }

  lspEditorFormatting(
    sessionId: string,
    relativePath: string,
    documentText: string,
    tabSize: number,
    insertSpaces: boolean,
    skipDocumentSync?: boolean,
  ): Promise<{ ok: true; edits: LspEditorTextEditPayload[] } | { ok: false; error: string }> {
    return (
      this.api?.lspEditorFormatting?.(
        sessionId,
        relativePath,
        documentText,
        tabSize,
        insertSpaces,
        skipDocumentSync === true,
      ) ?? Promise.resolve({ ok: false as const, error: 'API not available' })
    );
  }

  lspEditorRangeFormatting(
    sessionId: string,
    relativePath: string,
    startLine: number,
    startCharacter: number,
    endLine: number,
    endCharacter: number,
    documentText: string,
    tabSize: number,
    insertSpaces: boolean,
    skipDocumentSync?: boolean,
  ): Promise<{ ok: true; edits: LspEditorTextEditPayload[] } | { ok: false; error: string }> {
    return (
      this.api?.lspEditorRangeFormatting?.(
        sessionId,
        relativePath,
        startLine,
        startCharacter,
        endLine,
        endCharacter,
        documentText,
        tabSize,
        insertSpaces,
        skipDocumentSync === true,
      ) ?? Promise.resolve({ ok: false as const, error: 'API not available' })
    );
  }

  lspEditorOnTypeFormatting(
    sessionId: string,
    relativePath: string,
    line: number,
    character: number,
    ch: string,
    documentText: string,
    tabSize: number,
    insertSpaces: boolean,
    skipDocumentSync?: boolean,
  ): Promise<{ ok: true; edits: LspEditorTextEditPayload[] } | { ok: false; error: string }> {
    return (
      this.api?.lspEditorOnTypeFormatting?.(
        sessionId,
        relativePath,
        line,
        character,
        ch,
        documentText,
        tabSize,
        insertSpaces,
        skipDocumentSync === true,
      ) ?? Promise.resolve({ ok: false as const, error: 'API not available' })
    );
  }

  lspEditorInlayHints(
    sessionId: string,
    relativePath: string,
    startLine: number,
    startCharacter: number,
    endLine: number,
    endCharacter: number,
    documentText: string,
    skipDocumentSync?: boolean,
  ): Promise<
    | {
        ok: true;
        hints: Array<{
          position: { lineNumber: number; column: number };
          label: string;
          kind?: number;
          paddingLeft?: boolean;
          paddingRight?: boolean;
          tooltip?: string | { value: string; isTrusted?: boolean };
        }>;
      }
    | { ok: false; error: string }
  > {
    return (
      this.api?.lspEditorInlayHints?.(
        sessionId,
        relativePath,
        startLine,
        startCharacter,
        endLine,
        endCharacter,
        documentText,
        skipDocumentSync === true,
      ) ?? Promise.resolve({ ok: false as const, error: 'API not available' })
    );
  }

  lspEditorCodeLens(
    sessionId: string,
    relativePath: string,
    documentText: string,
    skipDocumentSync?: boolean,
  ): Promise<
    | {
        ok: true;
        lenses: Array<{
          range: LspEditorIRangePayload;
          command?: { title: string; command: string; arguments?: unknown };
          data?: unknown;
        }>;
      }
    | { ok: false; error: string }
  > {
    return (
      this.api?.lspEditorCodeLens?.(sessionId, relativePath, documentText, skipDocumentSync === true) ??
      Promise.resolve({ ok: false as const, error: 'API not available' })
    );
  }

  lspEditorCodeLensResolve(
    sessionId: string,
    relativePath: string,
    lens: Record<string, unknown>,
  ): Promise<
    | {
        ok: true;
        lens: {
          range: LspEditorIRangePayload;
          command?: { title: string; command: string; arguments?: unknown };
          data?: unknown;
        } | null;
      }
    | { ok: false; error: string }
  > {
    return (
      this.api?.lspEditorCodeLensResolve?.(sessionId, relativePath, lens) ??
      Promise.resolve({ ok: false as const, error: 'API not available' })
    );
  }

  lspDiagnosticsWatchStart(sessionId: string, relativePath: string): void {
    this.api?.lspDiagnosticsWatchStart?.(sessionId, relativePath);
  }

  lspDiagnosticsWatchStop(): void {
    this.api?.lspDiagnosticsWatchStop?.();
  }

  onLspDiagnosticsUpdated(callback: (payload: { sessionId: string; relativePath: string; generation: number }) => void): () => void {
    if (!this.api?.onLspDiagnosticsUpdated) {
      return () => {};
    }
    const handler = (_event: unknown, payload: { sessionId: string; relativePath: string; generation: number }) => {
      this.zone.run(() => callback(payload));
    };
    this.api.onLspDiagnosticsUpdated(handler);
    return () => {
      // ipcRenderer.on has no remove in typings; watch-stop clears server-side poll
    };
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

  depsList(): Promise<{
    ok: boolean;
    dependencies: import('@shared/index').DependencyInfo[];
    error?: string;
    warning?: string;
  }> {
    return (
      this.api?.depsList() ?? Promise.resolve({ ok: false, dependencies: [], error: 'No Electron API' })
    );
  }

  depsInstall(depId: import('@shared/index').DependencyId, variant?: string | null) {
    return (
      this.api?.depsInstall(depId, variant ?? null) ??
      Promise.resolve({ ok: false, error: 'No Electron API' })
    );
  }

  depsReinstall(depId: import('@shared/index').DependencyId, variant?: string | null) {
    return (
      this.api?.depsReinstall(depId, variant ?? null) ??
      Promise.resolve({ ok: false, error: 'No Electron API' })
    );
  }

  depsDelete(depId: import('@shared/index').DependencyId) {
    return this.api?.depsDelete(depId) ?? Promise.resolve({ ok: false, error: 'No Electron API' });
  }

  openDependenciesWindow(): void {
    this.api?.openDependenciesWindow();
  }

  closeDependenciesWindow(): void {
    this.api?.closeDependenciesWindow();
  }

  onDepsProgress(callback: (data: import('@shared/index').DependencyProgressEvent) => void): () => void {
    const handler = (_event: unknown, data: import('@shared/index').DependencyProgressEvent) => {
      this.zone.run(() => callback(data));
    };
    this.api?.onDepsProgress?.(handler);
    return () => this.api?.offDepsProgress?.(handler);
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

  /** OS-installed fonts for the Settings → General font pickers. Empty array if unavailable. */
  listSystemFonts(): Promise<SystemFontInfo[]> {
    return this.api?.listSystemFonts() ?? Promise.resolve([]);
  }
}
