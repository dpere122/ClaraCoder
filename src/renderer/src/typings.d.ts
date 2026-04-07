import type {
  AppConfig,
  CopyConfirmPayload,
  Conversation,
  ConversationMeta,
  DeleteConfirmPayload,
  FileDiffPayload,
  FileEntry,
  HealthLogRecord,
  HealthMetricsSnapshot,
  LlmStatus,
  PlannerProgress,
  TtsStreamPacket,
  Workspace,
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
    onMessageDone: (callback: (event: unknown, conversationId: string) => void) => void;
    onMessageStatus: (callback: (event: unknown, conversationId: string, status: LlmStatus) => void) => void;
    onMessagePlanner?: (
      callback: (event: unknown, conversationId: string, planner: PlannerProgress) => void,
    ) => void;
    onMessageDiff?: (callback: (event: unknown, conversationId: string, diff: FileDiffPayload) => void) => void;
    onMessageCopyConfirm?: (
      callback: (event: unknown, conversationId: string, payload: CopyConfirmPayload) => void,
    ) => void;
    onMessageDeleteConfirm?: (
      callback: (event: unknown, conversationId: string, payload: DeleteConfirmPayload) => void,
    ) => void;
    sendMessage: (conversationId: string, msg: string, applyMode?: boolean, autoApplyMode?: boolean) => void;
    abortMessage: (conversationId: string) => Promise<{ ok: boolean; error?: string }>;
    agentContinue: (
      conversationId: string,
      note: string,
      deleteAction?: 'confirm' | 'cancel',
      deleteRequestId?: string,
      copyAction?: 'confirm' | 'cancel',
      copyRequestId?: string,
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
    saveConfig: (config: AppConfig) => Promise<void>;
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
    setWorkspaceContext?: (sessionId: string, workspacePath: string, workspaceContext: string) => Promise<void>;
    getHostOs?: () => Promise<{ platform: string; release: string; arch: string; version: string; label: string }>;
    healthMetrics: () => Promise<HealthMetricsSnapshot>;
    healthLogsRecent: (limit: number) => Promise<{ records: HealthLogRecord[] }>;
    healthSetLogLevel: (level: string) => Promise<{ ok: boolean }>;
    healthLogsSubscribe: () => void;
    healthLogsUnsubscribe: () => void;
    onHealthLogRecord: (callback: (event: unknown, record: HealthLogRecord) => void) => void;
    openHealthWindow: () => void;
    closeHealthWindow: () => void;
  }

  interface Window {
    electronAPI?: ElectronAPI;
  }
}
