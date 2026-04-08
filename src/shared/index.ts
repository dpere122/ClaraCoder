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
  HealthMonitorConfig,
} from './types/app-config';
export type { LlmOptimizationPresetMeta } from './types/llm-presets';
export {
  LLM_OPTIMIZATION_PRESET_LIST,
  CAPABLE_PRESET_DEFAULTS,
  optimizationPresetsForProvider,
  QWEN_PRESET_DEFAULTS,
} from './types/llm-presets';
export { inferContextWindowTokens, resolveContextWindowTokens } from './model-context';
export type {
  ConversationMeta,
  ConversationMessage,
  Conversation,
  ConversationFile,
  ConversationSummary,
  DiffReviewStatus,
  StreamPart,
} from './types/conversation';
export {
  delegatedStreamPartsForDisplay,
  isPrimaryAssistantStreamTag,
  joinAllStreamPartTexts,
  primaryAssistantTextFromParts,
  primaryStreamPartsForDisplay,
  shouldIgnoreWhitespaceOnlyModelChunkDuringTool,
  streamIndicatesNestedSpecialistRouting,
  streamPlainOneLine,
} from './stream-parts';
export type { ParsedAgentStreamPayload } from './stream-payload';
export { normalizePlannerProgress, parseAgentStreamPayload } from './stream-payload';
export type {
  ClaraAgentMode,
  LlmAgentRole,
  LlmStatus,
  LlmStatusPayload,
  PlannerProgress,
  PlannerStep,
  PlannerStepState,
} from './types/llm';
export { claraModeFromLlmRole } from './types/llm';
export type { FileEntry, WorkspaceFilesChangedMessage } from './types/files';
export type { TtsStreamPacket } from './types/tts';
export type { HostOsInfo } from './types/host-os';
export type { ScriptLaunchPlan } from './types/script';
export type { DiffRow, DiffRowKind, FileDiffPayload, WorkspaceFileWriteOptions } from './types/diff';
export type { AcceptCommandPayload } from './types/accept-command';
export type { CopyConfirmItem, CopyConfirmPayload } from './types/copy-confirm';
export type { DeleteConfirmPayload } from './types/delete-confirm';
export type {
  WorkspaceContextState,
  WorkspaceChangeKind,
  WorkspaceFilesChangedPayload,
  WorkspaceChangeRecord,
} from './types/workspace-context';
export type { HealthLogLevel, HealthLogRecord, HealthMetricsSnapshot } from './types/health';
