/**
 * Cross-layer domain types for Electron main, preload, and Angular renderer.
 * No Node or Electron imports — safe to import from any compilation unit.
 */
export type { Workspace } from './types/workspace';
export type {
  LlmConnectionConfig,
  LlmOptimizationPreset,
  AudioTranscriptionConfig,
  AppConfig,
  WorkspaceToolsConfig,
} from './types/app-config';
export type { LlmOptimizationPresetMeta } from './types/llm-presets';
export {
  LLM_OPTIMIZATION_PRESET_LIST,
  optimizationPresetsForProvider,
  QWEN_PRESET_DEFAULTS,
} from './types/llm-presets';
export type {
  ConversationMeta,
  ConversationMessage,
  Conversation,
  ConversationFile,
  ConversationSummary,
  DiffReviewStatus,
} from './types/conversation';
export type { ClaraAgentMode, LlmAgentRole, LlmStatus, LlmStatusPayload } from './types/llm';
export { claraModeFromLlmRole } from './types/llm';
export type { FileEntry, WorkspaceFilesChangedMessage } from './types/files';
export type { TtsStreamPacket } from './types/tts';
export type { HostOsInfo } from './types/host-os';
export type { ScriptLaunchPlan } from './types/script';
export type { DiffRow, DiffRowKind, FileDiffPayload } from './types/diff';
export type {
  WorkspaceContextState,
  WorkspaceChangeKind,
  WorkspaceFilesChangedPayload,
  WorkspaceChangeRecord,
} from './types/workspace-context';
