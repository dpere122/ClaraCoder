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
  LspDashboardStatus,
  LlamaServerLifecycleEvent,
  LlamaServerOutputEvent,
  LlamaServerProcessExitEvent,
  LlamaServerStartResult,
  LlamaServerStatusResult,
  LlamacppManagedListModelsResult,
  LlmStatus,
  ModelManagerDetectCachesResult,
  ModelManagerHfSearchResult,
  ModelManagerListModelsResult,
  ModelManagerMigrateProgressPayload,
  ModelManagerMutationResult,
  LmStudioListModelsResult,
  LmStudioMutationResult,
  MaybeAutoTitleResult,
  PythonInterpreterListItem,
  TtsStreamPacket,
  Workspace,
  WorkspaceContextSyncExtras,
  WorkspaceFileWriteOptions,
  WorkspaceFilesChangedMessage,
} from '../../shared/index';
import type {
  LspEditorCompletionItemPayload,
  LspEditorDocumentSymbolPayload,
  LspEditorFlatSymbolPayload,
  LspEditorLocationPayload,
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
    onMessageDone: (callback: (event: unknown, conversationId: string) => void) => void;
    onMessageTokenUsage?: (
      callback: (
        event: unknown,
        conversationId: string,
        usage: { inputTokens: number; outputTokens?: number; totalTokens?: number },
      ) => void,
    ) => void;
    onMessageStatus: (callback: (event: unknown, conversationId: string, status: LlmStatus) => void) => void;
    onMessageHarnessCrystal?: (
      callback: (event: unknown, conversationId: string, polarity: 'positive' | 'negative') => void,
    ) => void;
    onMessageFinalText?: (
      callback: (event: unknown, conversationId: string, text: string) => void,
    ) => void;
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
    sendMessage: (
      conversationId: string,
      msg: string,
      applyMode?: boolean,
      autoApplyMode?: boolean,
      structuredContent?: ChatStructuredContentPart[],
      workspaceId?: string | null,
    ) => void;
    abortMessage: (conversationId: string) => Promise<{ ok: boolean; error?: string }>;
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
    ) => Promise<{ ok: boolean; error?: string }>;
    syncAutoApplyMode: (conversationId: string, autoApplyMode: boolean) => Promise<{ ok: boolean; error?: string }>;
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
    readWorkspaceFile?: (
      workspaceRoot: string,
      relativePath: string,
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
    startTtsStream: (text: string, voice: string, speed: number, seq: number) => Promise<{ ok: boolean }>;
    registerTtsStreamUrl: (text: string, voice: string, speed: number) => Promise<{ url: string }>;
    abortTtsStream: () => Promise<{ ok: boolean }>;
    onTtsStreamPacket: (callback: (packet: TtsStreamPacket) => void) => void;
    transcribe: (audio: ArrayBuffer) => Promise<string>;
    openDirectoryDialog: () => Promise<string | null>;
    readDirectory: (dirPath: string) => Promise<FileEntry[]>;
    readDirectoryRecursive: (dirPath: string) => Promise<string>;
    modelManagerPickCustomDir: () => Promise<string | null>;
    modelManagerListCustomModels: (payload: { customDir: string }) => Promise<ModelManagerListModelsResult>;
    modelManagerDetectCaches: () => Promise<ModelManagerDetectCachesResult>;
    modelManagerListCacheCandidates: (payload: { cachePaths: string[] }) => Promise<ModelManagerListModelsResult>;
    modelManagerChooseMigrateMode: (payload: {
      title?: string;
      detail?: string;
    }) => Promise<'copy' | 'move' | null>;
    modelManagerSubscribeMigrateProgress?: (
      callback: (payload: ModelManagerMigrateProgressPayload) => void,
    ) => () => void;
    modelManagerMigrateModel: (payload: {
      sourcePath: string;
      customDir: string;
      mode: 'copy' | 'move';
      suggestedFileName?: string;
      entryKind?: 'file' | 'hubRepo';
    }) => Promise<ModelManagerMutationResult>;
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
    }) => Promise<ModelManagerHfSearchResult>;
    loadConfig: () => Promise<AppConfig>;
    saveConfig: (config: AppConfig) => Promise<AppConfig>;
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
    setWorkspaceTheme: (workspaceId: string, themeId: string) => Promise<void>;
    setNoWorkspaceTheme: (themeId: string) => Promise<void>;
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
    getHostOs?: () => Promise<{ platform: string; release: string; arch: string; version: string; label: string }>;
    healthMetrics: () => Promise<HealthMetricsSnapshot>;
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
    ) => Promise<{ ok: true; markdown: string | null } | { ok: false; error: string }>;
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
    healthLogsRecent: (limit: number) => Promise<{ records: HealthLogRecord[] }>;
    healthSetLogLevel: (level: string) => Promise<{ ok: boolean }>;
    healthLogsSubscribe: () => void;
    healthLogsUnsubscribe: () => void;
    onHealthLogRecord: (callback: (event: unknown, record: HealthLogRecord) => void) => void;
    openHealthWindow: () => void;
    closeHealthWindow: () => void;
    popupFileMenu: (x: number, y: number) => Promise<void>;
    popupHelpMenu: (x: number, y: number) => Promise<void>;
    windowMinimize: () => void;
    windowToggleMaximize: () => void;
    windowClose: () => void;
    windowIsMaximized: () => Promise<boolean>;
    onWindowMaximizedChanged: (callback: (maximized: boolean) => void) => void;
  }

  interface Window {
    electronAPI?: ElectronAPI;
  }
}
