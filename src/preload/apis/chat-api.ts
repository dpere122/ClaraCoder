import { ipcRenderer } from 'electron';
import type {
  AcceptCommandPayload,
  CopyConfirmPayload,
  DeleteConfirmPayload,
  FileDiffPayload,
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
  onMessageDone: (callback: (event: unknown, conversationId: string) => void) => ipcRenderer.on('message-done', callback),
  onMessageTokenUsage: (
    callback: (
      event: unknown,
      conversationId: string,
      usage: { inputTokens: number; outputTokens?: number; totalTokens?: number },
    ) => void,
  ) => ipcRenderer.on('message-token-usage', callback),
  onMessageStatus: (callback: (event: unknown, conversationId: string, status: unknown) => void) =>
    ipcRenderer.on('message-status', callback),
  onMessageHarnessCrystal: (
    callback: (event: unknown, conversationId: string, polarity: 'positive' | 'negative') => void,
  ) => ipcRenderer.on('message-harness-crystal', callback),
  onMessageFinalText: (callback: (event: unknown, conversationId: string, text: string) => void) =>
    ipcRenderer.on('message-final-text', callback),
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
  sendMessage: (
    conversationId: string,
    msg: string,
    applyMode?: boolean,
    autoApplyMode?: boolean,
    structuredContent?: Record<string, unknown>[],
    workspaceId?: string | null,
  ) =>
    ipcRenderer.send(
      'message',
      conversationId,
      msg,
      applyMode ?? true,
      autoApplyMode ?? false,
      structuredContent,
      workspaceId ?? null,
    ),
  abortMessage: (conversationId: string) => ipcRenderer.invoke('abort-message', conversationId),
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
  ),
  syncAutoApplyMode: (conversationId: string, autoApplyMode: boolean) =>
    ipcRenderer.invoke('sync-auto-apply-mode', conversationId, autoApplyMode),
  startTtsStream: (text: string, voice: string, speed: number, seq: number) =>
    ipcRenderer.invoke('tts-stream-start', { text, voice, speed, seq }),
  registerTtsStreamUrl: (text: string, voice: string, speed: number) =>
    ipcRenderer.invoke('tts-stream-register', { text, voice, speed }),
  abortTtsStream: () => ipcRenderer.invoke('tts-stream-abort'),
  onTtsStreamPacket: (callback: (packet: TtsStreamPacket) => void) => {
    ipcRenderer.on('tts-stream-packet', (_event, packet) => callback(packet));
  },
  // Uint8Array survives Electron IPC structured clone more reliably than raw ArrayBuffer.
  transcribe: (audio: ArrayBuffer) => ipcRenderer.invoke('transcribe', new Uint8Array(audio)),
  closeSettingsWindow: () => ipcRenderer.send('close-settings-window'),
};
