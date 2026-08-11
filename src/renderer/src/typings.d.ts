import type {
  AcceptCommandPayload,
  AppConfig,
  ChatStructuredContentPart,
  CopyConfirmPayload,
  Conversation,
  ConversationMeta,
  DeleteConfirmPayload,
  FileDiffPayload,
  FileEntry,
  HealthLogRecord,
  HealthMetricsSnapshot,
  HealthMonitorConfig,
  RuntimeHealthSnapshot,
  LspDashboardStatus,
  LlamaServerLifecycleEvent,
  LlamaServerOutputEvent,
  LlamaServerProcessExitEvent,
  LlamaServerStartResult,
  LlamaServerStatusResult,
  LlamacppManagedListModelsResult,
  LlmStatus,
  ModelManagerHfFilesResult,
  ModelManagerHfSearchResult,
  ModelManagerListModelsResult,
  ModelManagerMutationResult,
  LmStudioListModelsResult,
  LmStudioMutationResult,
  MaybeAutoTitleResult,
  PythonInterpreterListItem,
  SystemFontInfo,
  TtsStreamPacket,
  Workspace,
  WorkspaceContextSyncExtras,
  WorkspaceFileWriteOptions,
  WorkspaceFilesChangedMessage,
  WorkspaceSystemPromptMutationResult,
  WorkspaceSystemPromptStatus,
} from '../../shared/index';
import type {
  LspEditorCompletionItemPayload,
  LspEditorDiagnosticPayload,
  LspEditorDocumentSymbolPayload,
  LspEditorFlatSymbolPayload,
  LspEditorIRangePayload,
  LspEditorLocationPayload,
  LspEditorTextEditPayload,
  LspSemanticTokensFullPayload,
  LspSemanticTokensLegendPayload,
  LspWorkspaceEditPayload,
} from './app/core/electron.service';

export {};

/**
 * Preload-exposed API (`contextBridge.exposeInMainWorld('electronAPI', …)`).
 * Channel names are implemented in `src/main/ipc/handlers/*`.
 */
declare global {
  interface ElectronAPI {
    onReady: () => void;
    onMessageChunk: (
      callback: (event: unknown, conversationId: string, delta: string, streamTag?: string) => void,
    ) => void;
    onMessageToolReadChunk: (callback: (event: unknown, conversationId: string, delta: string) => void) => void;
    onMessageToolExecChunk: (
      callback: (
        event: unknown,
        conversationId: string,
        delta: string,
        streamTag?: string,
        label?: string,
      ) => void,
    ) => void;
    onMessageToolExecComplete?: (
      callback: (
        event: unknown,
        conversationId: string,
        streamTag?: string,
        label?: string,
        exitCode?: number | null,
        outputExcerpt?: string,
        outcome?: 'passed' | 'failed',
      ) => void,
    ) => void;
    onMessageBackgroundCommandOpen?: (
      callback: (
        event: unknown,
        conversationId: string,
        payload: {
          commandId: string;
          commandText: string;
          cwdLabel: string;
          label: string;
          streamTag: string;
        },
      ) => void,
    ) => void;
    onMessageDone: (
      callback: (
        event: unknown,
        conversationId: string,
        outcome?: 'completed' | 'aborted' | 'error',
      ) => void,
    ) => void;
    onMessageTokenUsage?: (
      callback: (
        event: unknown,
        conversationId: string,
        usage: { inputTokens: number; outputTokens?: number; totalTokens?: number },
      ) => void,
    ) => void;
    onMessageContextCompressed?: (
      callback: (
        event: unknown,
        conversationId: string,
        payload: {
          tokensBefore: number;
          tokensAfter: number;
          toolMessagesCompacted: number;
          toolRoundsDropped: number;
        },
      ) => void,
    ) => void;
    onMessageStatus: (callback: (event: unknown, conversationId: string, status: LlmStatus) => void) => void;
    onMessageFinalText?: (
      callback: (event: unknown, conversationId: string, text: string) => void,
    ) => void;
    onMessageClearPrimaryStream?: (callback: (event: unknown, conversationId: string) => void) => void;
    onMessageDiff?: (callback: (event: unknown, conversationId: string, diff: FileDiffPayload) => void) => void;
    onMessageAcceptCommand?: (
      callback: (event: unknown, conversationId: string, payload: AcceptCommandPayload) => void,
    ) => void;
    onMessageCopyConfirm?: (
      callback: (event: unknown, conversationId: string, payload: CopyConfirmPayload) => void,
    ) => void;
    onMessageDeleteConfirm?: (
      callback: (event: unknown, conversationId: string, payload: DeleteConfirmPayload) => void,
    ) => void;
    onMessagePlannerProgress?: (
      callback: (event: unknown, conversationId: string, planner: import('@shared/index').PlannerProgress) => void,
    ) => void;
    onMessageBuildPlanOpen?: (
      callback: (
        event: unknown,
        conversationId: string,
        payload: import('@shared/index').BuildPlanOpenPayload,
      ) => void,
    ) => void;
    onMessageBuildPlanChunk?: (
      callback: (
        event: unknown,
        conversationId: string,
        payload: import('@shared/index').BuildPlanChunkPayload,
      ) => void,
    ) => void;
    onMessageBuildPlanStreamEnd?: (
      callback: (
        event: unknown,
        conversationId: string,
        payload: import('@shared/index').BuildPlanStreamEndPayload,
      ) => void,
    ) => void;
    onMessagePlanConfirm?: (
      callback: (event: unknown, conversationId: string, payload: import('@shared/index').PlanConfirmPayload) => void,
    ) => void;
    onMessageAgentQuestion?: (
      callback: (event: unknown, conversationId: string, payload: import('@shared/index').AgentQuestionPayload) => void,
    ) => void;
    onMessageStagedTransferBatch?: (
      callback: (
        event: unknown,
        conversationId: string,
        payload: import('@shared/index').StagedTransferBatchPayload,
      ) => void,
    ) => void;
    sendMessage: (
      conversationId: string,
      msg: string,
      applyMode?: boolean,
      autoApplyMode?: boolean,
      structuredContent?: ChatStructuredContentPart[],
      workspaceId?: string | null,
      composerMode?: 'agent' | 'plan',
      speechEnabled?: boolean,
    ) => void;
    abortMessage: (conversationId: string) => Promise<{ ok: boolean; error?: string }>;
    cancelBuildPlan: (conversationId: string, planId: string) => Promise<{ ok: boolean; error?: string }>;
    getPendingStreamIdsForWorkspace: (workspaceId: string | null) => Promise<string[]>;
    abortPendingStreamsForWorkspace: (workspaceId: string | null) => Promise<{ aborted: string[] }>;
    agentContinue: (
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
    ) => Promise<{ ok: boolean; error?: string; batchComplete?: boolean }>;
    agentQuestionAnswers: (
      conversationId: string,
      action: 'submit' | 'cancel',
      requestId: string,
      answers?: { questionId: string; optionId?: string; otherText?: string }[],
    ) => Promise<{ ok: boolean; error?: string }>;
    syncAutoApplyMode: (conversationId: string, autoApplyMode: boolean) => Promise<{ ok: boolean; error?: string }>;
    backgroundCommandTerminalClosed: (
      conversationId: string,
      commandId: string,
    ) => Promise<{ ok: boolean; error?: string; detail?: string }>;
    writeWorkspaceFile?: (
      workspaceRoot: string,
      relativePath: string,
      content: string,
      options?: WorkspaceFileWriteOptions,
    ) => Promise<{ ok: boolean; path?: string; error?: string }>;
    createWorkspaceFile?: (
      workspaceRoot: string,
      absoluteParentDir: string,
      fileName: string,
    ) => Promise<{ ok: boolean; path?: string; error?: string }>;
    createWorkspaceFolder?: (
      workspaceRoot: string,
      absoluteParentDir: string,
      folderName: string,
    ) => Promise<{ ok: boolean; path?: string; error?: string }>;
    deleteWorkspaceEntry?: (
      workspaceRoot: string,
      absolutePath: string,
    ) => Promise<{ ok: boolean; path?: string; error?: string }>;
    renameWorkspaceEntry?: (
      workspaceRoot: string,
      absolutePath: string,
      newName: string,
    ) => Promise<{ ok: boolean; path?: string; error?: string }>;
    moveWorkspaceEntry?: (
      workspaceRoot: string,
      sourceAbsolutePath: string,
      destParentAbsolutePath: string,
    ) => Promise<{ ok: boolean; path?: string; error?: string }>;
    importPathsIntoWorkspace?: (
      workspaceRoot: string,
      destParentAbsolutePath: string,
      sourceAbsolutePaths: string[],
    ) => Promise<{ ok: boolean; paths?: string[]; error?: string }>;
    readWorkspaceFile?: (
      workspaceRoot: string,
      relativePath: string,
    ) => Promise<{ ok: boolean; content?: string; path?: string; error?: string }>;
    readWorkspaceImageBase64?: (
      workspaceRoot: string,
      relativePath: string,
    ) => Promise<{ ok: boolean; dataUrl?: string; mime?: string; path?: string; error?: string }>;
    workspaceFileExists?: (
      workspaceRoot: string,
      relativePath: string,
    ) => Promise<{ ok: boolean; exists?: boolean; isFile?: boolean; error?: string }>;
    writeEditorDetachedSnapshot?: (content: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
    deleteEditorDetachedSnapshot?: (absolutePath: string) => Promise<{ ok: boolean; error?: string }>;
    promptSaveEditorFile?: (
      workspaceRoot: string,
      defaultRelativePath: string,
      content: string,
    ) => Promise<{
      ok: boolean;
      cancelled?: boolean;
      absolutePath?: string;
      relativePath?: string;
      outsideWorkspace?: boolean;
      error?: string;
    }>;
    writeAbsoluteFile?: (
      absolutePath: string,
      content: string,
    ) => Promise<{ ok: boolean; path?: string; error?: string }>;
    readAbsoluteFile?: (
      absolutePath: string,
    ) => Promise<{ ok: boolean; content?: string; path?: string; error?: string }>;
    setAlwaysOnTop: (pinned: boolean) => Promise<void>;
    getConversations: (workspaceId?: string | null) => Promise<ConversationMeta[]>;
    readConversationFromDisk: (id: string, workspaceId?: string | null) => Promise<Conversation>;
    loadConversation: (
      id: string,
      workspaceId?: string | null,
      options?: { skipPythonResync?: boolean },
    ) => Promise<Conversation>;
    saveConversation: (conv: Conversation) => Promise<void>;
    deleteConversation: (id: string, workspaceId?: string | null) => Promise<void>;
    renameConversation: (id: string, title: string, workspaceId?: string | null) => Promise<void>;
    maybeAutoTitleConversation: (id: string) => Promise<MaybeAutoTitleResult>;
    newConversation: (workspaceId: string | null) => Promise<Conversation>;
    startTtsStream: (
      text: string,
      voice: string,
      speed: number,
      seq: number,
      instructions?: string,
    ) => Promise<{ ok: boolean }>;
    registerTtsStreamUrl: (
      text: string,
      voice: string,
      speed: number,
      instructions?: string,
    ) => Promise<{ url: string }>;
    abortTtsStream: () => Promise<{ ok: boolean }>;
    onTtsStreamPacket: (callback: (packet: TtsStreamPacket) => void) => void;
    transcribe: (audio: ArrayBuffer) => Promise<string>;
    openDirectoryDialog: () => Promise<string | null>;
    readDirectory: (dirPath: string) => Promise<FileEntry[]>;
    readDirectoryRecursive: (dirPath: string) => Promise<string>;
    workspacePathIsDirectory: (absolutePath: string) => Promise<boolean>;
    showWorkspacePathInFileManager?: (absolutePath: string) => Promise<{ ok: boolean; error?: string }>;
    modelManagerPickCustomDir: () => Promise<string | null>;
    modelManagerListCustomModels: (payload: { customDir: string }) => Promise<ModelManagerListModelsResult>;
    modelManagerRenameModel: (payload: {
      customDir: string;
      modelPath: string;
      newFileName: string;
    }) => Promise<ModelManagerMutationResult>;
    modelManagerDeleteModel: (payload: { customDir: string; modelPath: string }) => Promise<ModelManagerMutationResult>;
    modelManagerSearchHf: (payload: {
      query: string;
      token?: string;
      limit?: number;
      skip?: number;
      fileType?: string;
    }) => Promise<ModelManagerHfSearchResult>;
    modelManagerListHfFiles: (payload: { id: string; token?: string }) => Promise<ModelManagerHfFilesResult>;
    loadConfig: () => Promise<AppConfig>;
    saveConfig: (config: AppConfig) => Promise<AppConfig>;
    setLastActiveConversation: (workspaceKey: string, conversationId: string) => Promise<AppConfig>;
    patchWorkspaceMonacoScroll: (
      workspaceId: string,
      relativePath: string,
      scroll: { scrollTop: number; scrollLeft: number } | null,
    ) => Promise<void>;
    setActiveLlmModel: (modelId: string) => Promise<AppConfig>;
    patchHealthMonitor: (patch: Partial<HealthMonitorConfig>) => Promise<AppConfig>;
    llamaServerStart: (payload: { modelId: string; config: AppConfig }) => Promise<LlamaServerStartResult>;
    llamaServerStop: (payload: { modelId: string; config: AppConfig }) => Promise<{ ok: true }>;
    llamaServerStatus: (payload: { modelId: string; config: AppConfig }) => Promise<LlamaServerStatusResult>;
    llamacppManagedListModels: (payload: {
      modelId: string;
      config: AppConfig;
    }) => Promise<LlamacppManagedListModelsResult>;
    llamacppOpenAiListModels: (payload: {
      baseUrl: string;
      apiKey: string;
    }) => Promise<LlamacppManagedListModelsResult>;
    lmStudioListModels: (payload: { baseUrl: string; apiKey?: string }) => Promise<LmStudioListModelsResult>;
    lmStudioLoadModel: (payload: { baseUrl: string; model: string; apiKey?: string }) => Promise<LmStudioMutationResult>;
    lmStudioUnloadModel: (payload: {
      baseUrl: string;
      instanceId: string;
      apiKey?: string;
    }) => Promise<LmStudioMutationResult>;
    getWorkspaces: () => Promise<Workspace[]>;
    addWorkspace: (name: string, path: string) => Promise<Workspace>;
    removeWorkspace: (id: string) => Promise<void>;
    setCurrentWorkspace: (id: string | null) => Promise<void>;
    getWorkspaceMonacoUnsavedPaths: () => Promise<string[]>;
    reportWorkspaceMonacoUnsavedPaths: (paths: string[]) => void;
    getCurrentWorkspace: () => Promise<Workspace | null>;
    setConversationTheme: (id: string, themeId: string) => Promise<void>;
    setTheme: (themeId: string) => Promise<AppConfig>;
    getActiveConversationId: () => Promise<string | null>;
    onConfigUpdated: (callback: (event: unknown, config: AppConfig) => void) => void;
    onSettingsWindowVisibilityChanged: (callback: (event: unknown, isOpen: boolean) => void) => void;
    closeSettingsWindow: () => void;
    onActiveConversationChanged: (callback: (event: unknown, conversationId: string) => void) => void;
    onConversationWorkspaceChanged: (
      callback: (event: unknown, data: { id: string; workspacePath: string }) => void,
    ) => void;
    onWorkspaceChanged: (callback: (event: unknown, workspaceId: string | null) => void) => void;
    onWorkspaceFilesChanged: (callback: (event: unknown, data: WorkspaceFilesChangedMessage) => void) => void;
    onOpenWorkspace: (callback: (event: unknown, path: string) => void) => void;
    onOpenConversation: (callback: (event: unknown, id: string) => void) => void;
    runScript: (
      script: string,
      language: string,
      workspacePath: string,
    ) => Promise<{ stdout: string; stderr: string; exitCode?: number }>;
    runScriptInteractive: (
      script: string,
      language: string,
      workspacePath: string,
    ) => Promise<{ processId: string | null; success: boolean; error?: string }>;
    sendScriptInput: (processId: string, input: string) => Promise<{ success: boolean; error?: string }>;
    endScript: (processId: string) => Promise<{ success: boolean; error?: string }>;
    onScriptOutput: (
      callback: (
        event: unknown,
        data: { processId: string; type: 'stdout' | 'stderr' | 'error'; data: string },
      ) => void,
    ) => void;
    onScriptComplete: (
      callback: (event: unknown, data: { processId: string; exitCode: number | null }) => void,
    ) => void;
  workspacePtySpawn: (
    workspaceRoot: string,
    cwd: string,
    cols: number,
    rows: number,
  ) => Promise<
      | { success: true; sessionId: string }
      | { success: false; error: string }
    >;
    workspacePtyWrite: (sessionId: string, data: string) => Promise<{ success: boolean; error?: string }>;
    workspacePtyResize: (
      sessionId: string,
      cols: number,
      rows: number,
    ) => Promise<{ success: boolean; error?: string }>;
    workspacePtyKill: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
    workspacePtyKillAll: () => Promise<{ success: boolean }>;
    onWorkspacePtyData: (
      callback: (event: unknown, data: { sessionId: string; data: string }) => void,
    ) => void;
    onWorkspacePtyExit: (
      callback: (
        event: unknown,
        data: { sessionId: string; exitCode: number; signal: number | null },
      ) => void,
    ) => void;
    onLlamaServerOutput?: (callback: (event: unknown, data: LlamaServerOutputEvent) => void) => void;
    onLlamaServerProcessExit?: (
      callback: (event: unknown, data: LlamaServerProcessExitEvent) => void,
    ) => void;
    onLlamaServerLifecycle?: (callback: (event: unknown, data: LlamaServerLifecycleEvent) => void) => void;
    setWorkspaceContext?: (
      sessionId: string,
      workspacePath: string,
      workspaceContext: string,
      extras?: WorkspaceContextSyncExtras,
    ) => Promise<void>;
    listPythonInterpreters?: (
      sessionId: string,
    ) => Promise<
      | { ok: true; interpreters: PythonInterpreterListItem[]; activeInterpreterId: string | null }
      | {
          ok: false;
          error: string;
          interpreters: PythonInterpreterListItem[];
          activeInterpreterId: string | null;
        }
    >;
    applyWorkspacePythonInterpreter?: (payload: {
      workspaceId: string;
      sessionId: string;
      interpreterId: string;
    }) => Promise<{ ok: true } | { ok: false; error: string }>;
    getWorkspaceSystemPromptStatus?: (workspaceId: string) => Promise<WorkspaceSystemPromptStatus>;
    pickWorkspaceSystemPrompt?: (
      workspaceId: string,
      sessionId?: string | null,
    ) => Promise<WorkspaceSystemPromptMutationResult>;
    getWorkspaceSystemPromptText?: (
      workspaceId: string,
    ) => Promise<{ ok: true; text: string } | { ok: false; error: string; text: string }>;
    saveWorkspaceSystemPromptText?: (payload: {
      workspaceId: string;
      text: string;
      sessionId?: string | null;
    }) => Promise<WorkspaceSystemPromptMutationResult>;
    clearWorkspaceSystemPrompt?: (
      workspaceId: string,
      sessionId?: string | null,
    ) => Promise<WorkspaceSystemPromptMutationResult>;
    getHostOs?: () => Promise<{ platform: string; release: string; arch: string; version: string; label: string }>;
    healthMetrics: () => Promise<HealthMetricsSnapshot>;
    healthRuntimeSnapshot: () => Promise<RuntimeHealthSnapshot>;
    getLspDashboardStatus: (
      sessionId: string,
    ) => Promise<{ ok: true; status: LspDashboardStatus } | { ok: false; error: string }>;
    warmLspForActiveFile?: (
      sessionId: string,
      relativePath: string,
      encoding?: string,
    ) => Promise<{ ok: true } | { ok: false; error: string }>;
    warmLspServer?: (sessionId: string, server: string) => Promise<{ ok: true } | { ok: false; error: string }>;
    lspEditorHover?: (
      sessionId: string,
      relativePath: string,
      line: number,
      character: number,
      documentText: string,
      skipDocumentSync?: boolean,
    ) => Promise<{ ok: true; markdown: string | null; range?: LspEditorIRangePayload | null } | { ok: false; error: string }>;
    lspEditorDefinition?: (
      sessionId: string,
      relativePath: string,
      line: number,
      character: number,
      documentText: string,
      skipDocumentSync?: boolean,
    ) => Promise<{ ok: true; locations: LspEditorLocationPayload[] } | { ok: false; error: string }>;
    lspEditorReferences?: (
      sessionId: string,
      relativePath: string,
      line: number,
      character: number,
      documentText: string,
      includeDeclaration: boolean,
      skipDocumentSync?: boolean,
    ) => Promise<{ ok: true; locations: LspEditorLocationPayload[] } | { ok: false; error: string }>;
    lspEditorDocumentSymbols?: (
      sessionId: string,
      relativePath: string,
      documentText: string,
      skipDocumentSync?: boolean,
    ) => Promise<
      | {
          ok: true;
          hierarchical: LspEditorDocumentSymbolPayload[];
          flat: LspEditorFlatSymbolPayload[];
        }
      | { ok: false; error: string }
    >;
    lspEditorCompletion?: (
      sessionId: string,
      relativePath: string,
      line: number,
      character: number,
      documentText: string,
      triggerKind: number,
      triggerCharacter: string | null,
      skipDocumentSync?: boolean,
    ) => Promise<
      | { ok: true; isIncomplete: boolean; items: LspEditorCompletionItemPayload[] }
      | { ok: false; error: string }
    >;
    lspEditorRename?: (
      sessionId: string,
      relativePath: string,
      line: number,
      character: number,
      documentText: string,
      newName: string,
      skipDocumentSync?: boolean,
    ) => Promise<{ ok: true; workspaceEdit: LspWorkspaceEditPayload | null } | { ok: false; error: string }>;
    lspEditorSemanticTokensLegend?: (
      sessionId: string,
      server: string,
    ) => Promise<{ ok: true; legend: LspSemanticTokensLegendPayload } | { ok: false; error: string }>;
    lspEditorSemanticTokensFull?: (
      sessionId: string,
      relativePath: string,
      documentText: string,
      skipDocumentSync?: boolean,
    ) => Promise<{ ok: true; payload: LspSemanticTokensFullPayload } | { ok: false; error: string }>;
    lspEditorDiagnostics?: (
      sessionId: string,
      relativePath: string,
      documentText: string,
      skipDocumentSync?: boolean,
    ) => Promise<
      | { ok: true; diagnostics: LspEditorDiagnosticPayload[]; generation: number }
      | { ok: false; error: string }
    >;
    lspDiagnosticsGeneration?: (
      sessionId: string,
      relativePath: string,
    ) => Promise<{ ok: true; generation: number; count: number } | { ok: false; error: string }>;
    lspEditorSignatureHelp?: (
      sessionId: string,
      relativePath: string,
      line: number,
      character: number,
      documentText: string,
      triggerCharacter: string | null,
      isRetrigger: boolean,
      skipDocumentSync?: boolean,
    ) => Promise<{ ok: true; signatureHelp: Record<string, unknown> | null } | { ok: false; error: string }>;
    lspEditorDocumentHighlight?: (
      sessionId: string,
      relativePath: string,
      line: number,
      character: number,
      documentText: string,
      skipDocumentSync?: boolean,
    ) => Promise<{ ok: true; highlights: Array<{ range: LspEditorIRangePayload; kind?: number }> } | { ok: false; error: string }>;
    lspEditorCompletionResolve?: (
      sessionId: string,
      relativePath: string,
      item: Record<string, unknown>,
    ) => Promise<{ ok: true; item: LspEditorCompletionItemPayload } | { ok: false; error: string }>;
    lspEditorCodeAction?: (
      sessionId: string,
      relativePath: string,
      startLine: number,
      startCharacter: number,
      endLine: number,
      endCharacter: number,
      documentText: string,
      diagnostics: LspEditorDiagnosticPayload[],
      skipDocumentSync?: boolean,
    ) => Promise<
      | {
          ok: true;
          actions: Array<{ title: string; kind: string; isPreferred?: boolean; edit?: LspWorkspaceEditPayload }>;
        }
      | { ok: false; error: string }
    >;
    lspEditorFormatting?: (
      sessionId: string,
      relativePath: string,
      documentText: string,
      tabSize: number,
      insertSpaces: boolean,
      skipDocumentSync?: boolean,
    ) => Promise<{ ok: true; edits: LspEditorTextEditPayload[] } | { ok: false; error: string }>;
    lspEditorRangeFormatting?: (
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
    ) => Promise<{ ok: true; edits: LspEditorTextEditPayload[] } | { ok: false; error: string }>;
    lspEditorOnTypeFormatting?: (
      sessionId: string,
      relativePath: string,
      line: number,
      character: number,
      ch: string,
      documentText: string,
      tabSize: number,
      insertSpaces: boolean,
      skipDocumentSync?: boolean,
    ) => Promise<{ ok: true; edits: LspEditorTextEditPayload[] } | { ok: false; error: string }>;
    lspEditorInlayHints?: (
      sessionId: string,
      relativePath: string,
      startLine: number,
      startCharacter: number,
      endLine: number,
      endCharacter: number,
      documentText: string,
      skipDocumentSync?: boolean,
    ) => Promise<
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
    >;
    lspEditorCodeLens?: (
      sessionId: string,
      relativePath: string,
      documentText: string,
      skipDocumentSync?: boolean,
    ) => Promise<
      | {
          ok: true;
          lenses: Array<{ range: LspEditorIRangePayload; command?: { title: string; command: string; arguments?: unknown } }>;
        }
      | { ok: false; error: string }
    >;
    lspEditorCodeLensResolve?: (
      sessionId: string,
      relativePath: string,
      lens: Record<string, unknown>,
    ) => Promise<
      | { ok: true; lens: { range: LspEditorIRangePayload; command?: { title: string; command: string; arguments?: unknown } } | null }
      | { ok: false; error: string }
    >;
    lspEditorSemanticTokensDelta?: (
      sessionId: string,
      relativePath: string,
      previousResultId: string,
      documentText: string,
      skipDocumentSync?: boolean,
    ) => Promise<
      | {
          ok: true;
          payload: {
            legend: { tokenTypes: string[]; tokenModifiers: string[] };
            resultId: string | null;
            edits: unknown[];
          };
        }
      | { ok: false; error: string }
    >;
    lspDiagnosticsWatchStart?: (sessionId: string, relativePath: string) => void;
    lspDiagnosticsWatchStop?: () => void;
    onLspDiagnosticsUpdated?: (
      callback: (event: unknown, payload: { sessionId: string; relativePath: string; generation: number }) => void,
    ) => void;
    healthLogsRecent: (limit: number) => Promise<{ records: HealthLogRecord[] }>;
    healthSetLogLevel: (level: string) => Promise<{ ok: boolean }>;
    healthLogsSubscribe: () => void;
    healthLogsUnsubscribe: () => void;
    onHealthLogRecord: (callback: (event: unknown, record: HealthLogRecord) => void) => void;
    openHealthWindow: () => void;
    closeHealthWindow: () => void;
    depsList: () => Promise<{
      ok: boolean;
      dependencies: import('@shared/index').DependencyInfo[];
      error?: string;
      warning?: string;
    }>;
    depsInstall: (
      depId: import('@shared/index').DependencyId,
      variant?: string | null,
    ) => Promise<import('@shared/index').DependencyActionResult>;
    depsReinstall: (
      depId: import('@shared/index').DependencyId,
      variant?: string | null,
    ) => Promise<import('@shared/index').DependencyActionResult>;
    depsDelete: (
      depId: import('@shared/index').DependencyId,
    ) => Promise<import('@shared/index').DependencyActionResult>;
    openDependenciesWindow: () => void;
    closeDependenciesWindow: () => void;
    onDepsProgress: (
      callback: (event: unknown, data: import('@shared/index').DependencyProgressEvent) => void,
    ) => void;
    offDepsProgress: (
      callback: (event: unknown, data: import('@shared/index').DependencyProgressEvent) => void,
    ) => void;
    popupFileMenu: (x: number, y: number) => Promise<void>;
    popupHelpMenu: (x: number, y: number) => Promise<void>;
    windowMinimize: () => void;
    windowToggleMaximize: () => void;
    windowClose: () => void;
    windowIsMaximized: () => Promise<boolean>;
    onWindowMaximizedChanged: (callback: (maximized: boolean) => void) => void;
    onEditorFindRequested: (callback: () => void) => void;
    listSystemFonts: () => Promise<SystemFontInfo[]>;
  }

  interface Window {
    electronAPI?: ElectronAPI;
  }
}
