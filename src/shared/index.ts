/**
 * Cross-layer domain types for Electron main, preload, and Angular renderer.
 * No Node or Electron imports — safe to import from any compilation unit.
 */
export type { Workspace } from './types/workspace';
export type {
  LlmConnectionConfig,
  AudioTranscriptionConfig,
  AppConfig,
} from './types/app-config';
export type {
  ConversationMeta,
  ConversationMessage,
  Conversation,
  ConversationFile,
  ConversationSummary,
} from './types/conversation';
export type { LlmStatus, LlmStatusPayload } from './types/llm';
export type { FileEntry, WorkspaceFilesChangedMessage } from './types/files';
export type { TtsStreamPacket } from './types/tts';
export type { HostOsInfo } from './types/host-os';
export type { ScriptLaunchPlan } from './types/script';
export type {
  WorkspaceContextState,
  WorkspaceChangeKind,
  WorkspaceFilesChangedPayload,
  WorkspaceChangeRecord,
} from './types/workspace-context';
