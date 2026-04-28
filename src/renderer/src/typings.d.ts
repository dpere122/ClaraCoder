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
} from '../../shared/index';

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
      ) => void,
    ) => void;
    onMessageDone: (callback: (event: unknown, conversationId: string) => void) => void;
    onMessageStatus: (callback: (event: unknown, conversationId: string, status: LlmStatus) => void) => void;
    onMessageHarnessCrystal?: (
      callback: (event: unknown, conversationId: string, polarity: 'positive' | 'negative') => void,
    ) => void;
    onMessagePlanner?: (
      callback: (event: unknown, conversationId: string, planner: PlannerProgress) => void,
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
    ) => void;
    abortMessage: (conversationId: string) => Promise<{ ok: boolean; error?: string }>;
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
    setAlwaysOnTop: (pinned: boolean) => Promise<void>;
    getConversations: (workspaceId?: string | null) => Promise<ConversationMeta[]>;
    loadConversation: (id: string, workspaceId?: string | null) => Promise<Conversation>;
    saveConversation: (conv: Conversation) => Promise<void>;
    deleteConversation: (id: string, workspaceId?: string | null) => Promise<void>;
    renameConversation: (id: string, title: string, workspaceId?: string | null) => Promise<void>;
    newConversation: (workspaceId: string | null) => Promise<Conversation>;
    startTtsStream: (text: string, voice: string, seq: number) => Promise<{ ok: boolean }>;
    registerTtsStreamUrl: (text: string, voice: string) => Promise<{ url: string }>;
    abortTtsStream: () => Promise<{ ok: boolean }>;
    onTtsStreamPacket: (callback: (packet: TtsStreamPacket) => void) => void;
    transcribe: (audio: ArrayBuffer) => Promise<string>;
    openDirectoryDialog: () => Promise<string | null>;
    readDirectory: (dirPath: string) => Promise<FileEntry[]>;
    readDirectoryRecursive: (dirPath: string) => Promise<string>;
    loadConfig: () => Promise<AppConfig>;
    saveConfig: (config: AppConfig) => Promise<AppConfig>;
    llamaServerStart: (payload: { modelId: string; config: AppConfig }) => Promise<LlamaServerStartResult>;
    llamaServerStop: (payload: { modelId: string; config: AppConfig }) => Promise<{ ok: true }>;
    llamaServerStatus: (payload: { modelId: string; config: AppConfig }) => Promise<LlamaServerStatusResult>;
    getWorkspaces: () => Promise<Workspace[]>;
    addWorkspace: (name: string, path: string) => Promise<Workspace>;
    removeWorkspace: (id: string) => Promise<void>;
    setCurrentWorkspace: (id: string | null) => Promise<void>;
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
    getHostOs?: () => Promise<{ platform: string; release: string; arch: string; version: string; label: string }>;
    healthMetrics: () => Promise<HealthMetricsSnapshot>;
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
