/**
 * Cross-layer domain types for Electron main, preload, and Angular renderer.
 * No Node or Electron imports — safe to import from any compilation unit.
 */
export type { Workspace } from './types/workspace';
export { looksLikeLlamaModelDownload, managedLlamaCmdUsesHfRemoteModel } from './llama-model-download';
export type {
  LlamaServerLifecycleEvent,
  LlamaServerOutputEvent,
  LlamaServerProcessExitEvent,
  LlamaServerStartResult,
  LlamaServerStatusPayload,
  LlamaServerStatusResult,
  LlamaServerStreamKind,
  ManagedServerHealthState,
} from './types/llama-server-ipc';
export type {
  LlamaCppManaged,
  LlamaManagedRuntimeEndpoints,
  LlmConnectionConfig,
  LlmModelProfile,
  LlmProviderConfig,
  LlmOptimizationPreset,
  GemmaArchitectureHint,
  GemmaSamplingPreset,
  GemmaThinkingMode,
  AudioTranscriptionConfig,
  AppConfig,
  WorkspaceToolsConfig,
  HealthMonitorConfig,
} from './types/app-config';
export type { LlamaCppEmbeddingManagedLegacy, LlamaCppManagedLegacy, ShellQuotingPlatform } from './llama-cpp-managed';
export {
  argvToShellCommandLine,
  buildLlamaServerArgv,
  defaultLlamaCppManaged,
  detectShellQuotingPlatform,
  isLegacyLlamaCppManagedShape,
  migrateLegacyLlamaCppManagedToCommands,
  parseHostFromLlamaCommand,
  prepareManagedLlamaShellCommand,
  shellQuoteArg,
} from './llama-cpp-managed';
export {
  countLlmModels,
  findLlmModelLocation,
  flattenLlmProvidersToConnections,
  mergeLlmProviderModel,
  resolveActiveLlmConnection,
} from './llm-providers';
export type { LlmOptimizationPresetMeta } from './types/llm-presets';
export {
  LLM_OPTIMIZATION_PRESET_LIST,
  CAPABLE_PRESET_DEFAULTS,
  GEMMA_PRESET_DEFAULTS,
  optimizationPresetsForProvider,
  QWEN_PRESET_DEFAULTS,
} from './types/llm-presets';
export { inferContextWindowTokens, isGemmaFamily, resolveContextWindowTokens } from './model-context';
export {
  collapseExcessiveAssistantBlankLines,
  gemmaTemplateSanitizeActive,
  isPlaceholderThinkingNoise,
  sanitizeGemmaVisibleAssistantText,
  stripAssistantChannelNoise,
  stripLlmControlMarkers,
  stripPseudoToolCallXml,
} from './llm-visible-text';
export type {
  ChatStructuredContentPart,
  ConversationMeta,
  ConversationMessage,
  Conversation,
  ConversationFile,
  ConversationFileMessage,
  ConversationSummary,
  DiffReviewStatus,
  StreamPart,
} from './types/conversation';
export {
  auxiliaryTimelineEmbedsToolStatus,
  CLARA_OUTER_BRIEF_STREAM_TAG,
  MOE_AUXILIARY_STREAM_TAG,
  delegatedStreamPartsForDisplay,
  emptyPrimaryAssistantFallbackMessage,
  isClaraOuterBriefStreamTag,
  isMoeAuxiliaryStreamTag,
  isPrimaryAssistantStreamTag,
  isShellStyleToolStreamTag,
  isToolTrailStatusStreamTag,
  joinAllStreamPartTexts,
  joinPrimaryAssistantStreamText,
  moeStreamPartsForDisplay,
  multiplexAuxiliaryStreamTimeline,
  otherDelegatedStreamPartsForDisplay,
  persistedAuxiliaryStreamTimeline,
  primaryAssistantTextFromParts,
  primaryStreamPartsForDisplay,
  SHELL_STYLE_TOOL_STREAM_TAGS,
  shellDelegatedStreamPartsForDisplay,
  shouldIgnoreWhitespaceOnlyModelChunkDuringTool,
  streamIndicatesNestedSpecialistRouting,
  streamPlainOneLine,
  toolTrailStatusStreamTag,
  TOOL_TRAIL_STATUS_STREAM_PREFIX,
} from './stream-parts';
export type { PersistedAssistantStreamFields } from './stream-parts';
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
export type { DeleteConfirmEntry, DeleteConfirmPayload } from './types/delete-confirm';
export type {
  WorkspaceContextState,
  WorkspaceChangeKind,
  WorkspaceFilesChangedPayload,
  WorkspaceChangeRecord,
  WorkspaceContextSyncExtras,
  WorkspaceFileChangesForSync,
} from './types/workspace-context';
export type { HealthLogLevel, HealthLogRecord, HealthMetricsSnapshot } from './types/health';
