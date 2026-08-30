import { ipcRenderer } from 'electron';
import type {
  AcceptCommandPayload,
  CopyConfirmPayload,
  DeleteConfirmPayload,
  FileDiffPayload,
  AppendConversationFileJournalRequest,
  StagedTransferBatchPayload,
  TtsProvider,
  TtsStreamPacket,
} from '../../shared';

/** Chat streaming, agent continue, and TTS IPC surface. */
export const chatApi = {
  onReady: () => ipcRenderer.send('ready'),
  onMessageChunk: (
    callback: (event: unknown, conversationId: string, delta: string, streamTag?: string) => void,
  ) => ipcRenderer.on('message-chunk', callback),
  onMessageToolReadChunk: (callback: (event: unknown, conversationId: string, delta: string) => void) =>
    ipcRenderer.on('message-tool-read-chunk', callback),
  onMessageToolExecChunk: (
    callback: (
      event: unknown,
      conversationId: string,
      delta: string,
      streamTag?: string,
      label?: string,
    ) => void,
  ) => ipcRenderer.on('message-tool-exec-chunk', callback),
  onMessageToolExecComplete: (
    callback: (
      event: unknown,
      conversationId: string,
      streamTag?: string,
      label?: string,
      exitCode?: number | null,
      outputExcerpt?: string,
      outcome?: 'passed' | 'failed',
    ) => void,
  ) => ipcRenderer.on('message-tool-exec-complete', callback),
  onMessageBackgroundCommandOpen: (
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
  ) => ipcRenderer.on('message-background-command-open', callback),
  onMessageDone: (
    callback: (
      event: unknown,
      conversationId: string,
      outcome?: 'completed' | 'aborted' | 'error',
    ) => void,
  ) => ipcRenderer.on('message-done', callback),
  onMessageTokenUsage: (
    callback: (
      event: unknown,
      conversationId: string,
      usage: { inputTokens: number; outputTokens?: number; totalTokens?: number },
    ) => void,
  ) => ipcRenderer.on('message-token-usage', callback),
  onMessageContextCompressed: (
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
  ) => ipcRenderer.on('message-context-compressed', callback),
  onMessageStatus: (callback: (event: unknown, conversationId: string, status: unknown) => void) =>
    ipcRenderer.on('message-status', callback),
  onMessageFinalText: (callback: (event: unknown, conversationId: string, text: string) => void) =>
    ipcRenderer.on('message-final-text', callback),
  onMessageClearPrimaryStream: (callback: (event: unknown, conversationId: string) => void) =>
    ipcRenderer.on('message-clear-primary-stream', callback),
  onMessagePromotePrimaryToNudge: (callback: (event: unknown, conversationId: string) => void) =>
    ipcRenderer.on('message-promote-primary-to-nudge', callback),
  onMessageDiff: (callback: (event: unknown, conversationId: string, diff: FileDiffPayload) => void) =>
    ipcRenderer.on('message-diff', callback),
  onMessageAcceptCommand: (
    callback: (event: unknown, conversationId: string, payload: AcceptCommandPayload) => void,
  ) => ipcRenderer.on('message-accept-command', callback),
  onMessageCopyConfirm: (
    callback: (event: unknown, conversationId: string, payload: CopyConfirmPayload) => void,
  ) => ipcRenderer.on('message-copy-confirm', callback),
  onMessageDeleteConfirm: (
    callback: (event: unknown, conversationId: string, payload: DeleteConfirmPayload) => void,
  ) => ipcRenderer.on('message-delete-confirm', callback),
  onMessagePlannerProgress: (
    callback: (event: unknown, conversationId: string, planner: unknown) => void,
  ) => ipcRenderer.on('message-planner-progress', callback),
  onMessageBuildPlanOpen: (
    callback: (event: unknown, conversationId: string, payload: unknown) => void,
  ) => ipcRenderer.on('message-build-plan-open', callback),
  onMessageBuildPlanChunk: (
    callback: (event: unknown, conversationId: string, payload: unknown) => void,
  ) => ipcRenderer.on('message-build-plan-chunk', callback),
  onMessageBuildPlanStreamEnd: (
    callback: (event: unknown, conversationId: string, payload: unknown) => void,
  ) => ipcRenderer.on('message-build-plan-stream-end', callback),
  onMessagePlanConfirm: (
    callback: (event: unknown, conversationId: string, payload: unknown) => void,
  ) => ipcRenderer.on('message-plan-confirm', callback),
  onMessageAgentQuestion: (
    callback: (event: unknown, conversationId: string, payload: unknown) => void,
  ) => ipcRenderer.on('message-agent-question', callback),
  onMessageStagedTransferBatch: (
    callback: (event: unknown, conversationId: string, payload: StagedTransferBatchPayload) => void,
  ) => ipcRenderer.on('message-staged-transfer-batch', callback),
  onMessageFileJournal: (
    callback: (
      event: unknown,
      conversationId: string,
      payload: Omit<AppendConversationFileJournalRequest, 'conversationId'>,
    ) => void,
  ) => ipcRenderer.on('message-file-journal', callback),
  sendMessage: (
    conversationId: string,
    msg: string,
    applyMode?: boolean,
    autoApplyMode?: boolean,
    structuredContent?: Record<string, unknown>[],
    workspaceId?: string | null,
    composerMode?: 'agent' | 'plan',
    speechEnabled?: boolean,
    ttsProvider?: TtsProvider,
    userMessageId?: string,
  ) =>
    ipcRenderer.send(
      'message',
      conversationId,
      msg,
      applyMode ?? true,
      autoApplyMode ?? false,
      structuredContent,
      workspaceId ?? null,
      composerMode ?? 'agent',
      speechEnabled ?? false,
      ttsProvider ?? 'kokoro',
      userMessageId ?? '',
    ),
  abortMessage: (conversationId: string) => ipcRenderer.invoke('abort-message', conversationId),
  cancelBuildPlan: (conversationId: string, planId: string) =>
    ipcRenderer.invoke('build-plan-cancel', conversationId, planId),
  getPendingStreamIdsForWorkspace: (workspaceId: string | null) =>
    ipcRenderer.invoke('get-pending-stream-ids-for-workspace', workspaceId),
  abortPendingStreamsForWorkspace: (workspaceId: string | null) =>
    ipcRenderer.invoke('abort-pending-streams-for-workspace', workspaceId),
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
  ) => ipcRenderer.invoke(
    'agent-continue',
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
  ),
  agentQuestionAnswers: (
    conversationId: string,
    action: 'submit' | 'cancel',
    requestId: string,
    answers?: { questionId: string; optionId?: string; otherText?: string }[],
  ) =>
    ipcRenderer.invoke('agent-question-answers', conversationId, action, requestId, answers ?? []),
  syncAutoApplyMode: (conversationId: string, autoApplyMode: boolean) =>
    ipcRenderer.invoke('sync-auto-apply-mode', conversationId, autoApplyMode),
  backgroundCommandTerminalClosed: (conversationId: string, commandId: string) =>
    ipcRenderer.invoke('background-command-terminal-closed', conversationId, commandId),
  startTtsStream: (text: string, voice: string, speed: number, seq: number, instructions?: string) =>
    ipcRenderer.invoke('tts-stream-start', { text, voice, speed, seq, instructions }),
  registerTtsStreamUrl: (text: string, voice: string, speed: number, instructions?: string) =>
    ipcRenderer.invoke('tts-stream-register', { text, voice, speed, instructions }),
  abortTtsStream: () => ipcRenderer.invoke('tts-stream-abort'),
  onTtsStreamPacket: (callback: (packet: TtsStreamPacket) => void) => {
    ipcRenderer.on('tts-stream-packet', (_event, packet) => callback(packet));
  },
  // Uint8Array survives Electron IPC structured clone more reliably than raw ArrayBuffer.
  transcribe: (audio: ArrayBuffer) => ipcRenderer.invoke('transcribe', new Uint8Array(audio)),
  closeSettingsWindow: () => ipcRenderer.send('close-settings-window'),
};
