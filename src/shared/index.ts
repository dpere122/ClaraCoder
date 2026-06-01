/**
 * Cross-layer domain types for Electron main, preload, and Angular renderer.
 * No Node or Electron imports — safe to import from any compilation unit.
 */
export type { Workspace } from './types/workspace';
export type { ComposerRunMode } from './types/composer-mode';
export {
  COMPOSER_RUN_MODES,
  COMPOSER_RUN_MODE_LABELS,
  DEFAULT_COMPOSER_RUN_MODE,
} from './types/composer-mode';
export { looksLikeLlamaModelDownload, managedLlamaCmdUsesHfRemoteModel } from './llama-model-download';
export type {
  LlamaServerLifecycleEvent,
  LlamaServerOutputEvent,
  LlamaServerProcessExitEvent,
  LlamaServerStartResult,
  LlamaServerStatusPayload,
  LlamaServerStatusResult,
  LlamacppManagedListModelsResult,
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
  MonacoWorkspaceEditorSettings,
  MonacoWorkspaceEditorThemeId,
  WorkspaceToolsConfig,
  ContextCompressionConfig,
  HealthMonitorConfig,
  ModelManagerConfig,
} from './types/app-config';
export {
  DEFAULT_KOKORO_TTS_VOICE,
  MONACO_WORKSPACE_EDITOR_THEME_IDS,
  TTS_SPEECH_SPEED_DEFAULT,
  TTS_SPEECH_SPEED_MAX,
  TTS_SPEECH_SPEED_MIN,
  defaultMonacoWorkspaceEditorSettings,
  getDefaultContextCompression,
  normalizeMonacoWorkspaceEditorSettings,
} from './types/app-config';
export { QWEN_INFERENCE_CHAT_TEMPLATE_FILENAME } from './qwen-template';
export type { LlamaCppEmbeddingManagedLegacy, LlamaCppManagedLegacy, ShellQuotingPlatform } from './llama-cpp-managed';
export {
  appendQwenChatTemplateFlagsToManagedChatCommand,
  argvToShellCommandLine,
  buildLlamaServerArgv,
  DEFAULT_MANAGED_LLAMA_CHAT_RUN_COMMAND,
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
  PINNED_LLAMA_CPP_LOCAL_PROVIDER_ID,
  PINNED_LM_STUDIO_PROVIDER_ID,
  PINNED_LLAMA_SERVER_URL_PROVIDER_ID,
  isPinnedLmStudioProviderId,
  isPinnedLlamaCppLocalProviderId,
  isPinnedLlamaServerUrlProviderId,
  isPinnedLlmSourceId,
} from './llm-provider-ids';
export { lmStudioOpenAiBaseUrlToRestOrigin } from './lm-studio-url';
export type { LmStudioModelCard, LmStudioListModelsResult, LmStudioMutationResult } from './lm-studio-ipc';
export type {
  ChatStructuredContentPart,
  ConversationMeta,
  ConversationMessage,
  Conversation,
  ConversationFile,
  ConversationFileMessage,
  ConversationSummary,
  DiffReviewStatus,
  MaybeAutoTitleResult,
  StreamPart,
} from './types/conversation';
export {
  auxiliaryTimelineEmbedsToolStatus,
  CLARA_OUTER_BRIEF_STREAM_TAG,
  REASONING_AUXILIARY_STREAM_TAG,
  PLANNER_STREAM_TAG,
  delegatedStreamPartsForDisplay,
  emptyPrimaryAssistantFallbackMessage,
  isClaraOuterBriefStreamTag,
  isReasoningAuxiliaryStreamTag,
  isPrimaryAssistantStreamTag,
  isShellStyleToolStreamTag,
  isToolTrailStatusStreamTag,
  joinAllStreamPartTexts,
  joinPrimaryAssistantStreamText,
  normalizeReasoningStreamPart,
  normalizeStreamPart,
  normalizeStreamTag,
  persistedReasoningStreams,
  reasoningStreamPartsForDisplay,
  multiplexAuxiliaryStreamTimeline,
  otherDelegatedStreamPartsForDisplay,
  persistedAuxiliaryStreamTimeline,
  primaryAssistantTextFromParts,
  primaryStreamPartsForDisplay,
  appendAndMergeReadToolPreviewChunk,
  appendReadToolPreviewChunk,
  findReadToolTrailTargetIndex,
  isReadToolPreviewStreamTag,
  isWorkspaceReadToolLabel,
  mergeReadPreviewIntoToolTrailParts,
  READ_TOOL_PREVIEW_STREAM_TAG,
  WORKSPACE_READ_TOOL_NAMES,
  TOOL_NODE_SMOKE_STREAM_TAG,
  TOOL_OVERLAY_STREAM_TAG,
  TOOL_PYTEST_STREAM_TAG,
  TOOL_SMOKE_STREAM_TAG,
  SHELL_STYLE_TOOL_STREAM_TAGS,
  shellDelegatedStreamPartsForDisplay,
  shouldIgnoreWhitespaceOnlyModelChunkDuringTool,
  streamPlainOneLine,
  toolTrailStatusIdFromStreamTag,
  toolTrailStatusStreamTag,
  TOOL_TRAIL_STATUS_STREAM_PREFIX,
} from './stream-parts';
export type { PersistedAssistantStreamFields } from './stream-parts';
export {
  condenseToolTrailText,
  readToolPreviewBody,
  readToolPreviewTail,
  readToolPreviewTailForDisplay,
  readToolStatusHeadline,
  READ_TOOL_STREAM_BODY_MARKER,
  delegatedStreamPartMeta,
  shellStreamPartBadgeMeta,
  shellStreamPartPillState,
  shouldShowReadToolPreview,
  streamPartIsExpandable,
  terminalTailPreview,
  toolStatusStreamPartMeta,
  toolStatusStreamPartPillState,
} from './tool-trail-pill';
export type { ToolTrailPillState } from './tool-trail-pill';
export type { ParsedAgentStreamPayload } from './stream-payload';
export { parseAgentStreamPayload } from './stream-payload';
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
export { diffLineChangeCounts, formatDiffLineChangeSummary } from './diff-stats';
export type { DiffLineChangeCounts } from './diff-stats';
export {
  hitlTrailItemsFromArtifacts,
  hitlTrailKindLabel,
  hitlTrailPanelTitle,
  hitlTrailRowKindText,
  hitlTrailStatusLabel,
} from './hitl-trail';
export type { HitlTrailArtifact, HitlTrailItem, HitlTrailKind } from './hitl-trail';
export type { LspDashboardServerEntry, LspDashboardStatus } from './types/lsp-dashboard';
export { lspServerKindForWorkspaceRelativePath } from './lsp-file-policy';
export type { LspServerKind } from './lsp-file-policy';
export {
  LSP_EXTENSION_TO_SERVER,
  LSP_MONACO_LANGUAGE_IDS,
  LSP_SEMANTIC_LEGEND_PREFETCH_SERVER_IDS,
  LSP_SEMANTIC_LEGEND_SERVER_IDS,
  lspServerIdForMonacoLanguageId,
} from './lsp-file-policy';
export type { AcceptCommandPayload } from './types/accept-command';
export type { PlanConfirmPayload } from './types/plan-confirm';
export type { CopyConfirmItem, CopyConfirmPayload } from './types/copy-confirm';
export type { DeleteConfirmEntry, DeleteConfirmPayload } from './types/delete-confirm';
export type {
  WorkspaceContextState,
  WorkspaceChangeKind,
  WorkspaceFilesChangedPayload,
  WorkspaceChangeRecord,
  WorkspaceContextSyncExtras,
  WorkspaceFileChangesForSync,
  PythonInterpreterListItem,
} from './types/workspace-context';
export type { HealthLogLevel, HealthLogRecord, HealthMetricsSnapshot } from './types/health';
export type {
  HuggingFaceModelSearchItem,
  ModelManagerCacheLocation,
  ModelManagerDetectCachesResult,
  ModelManagerEntryKind,
  ModelManagerFileEntry,
  ModelManagerHfSearchResult,
  ModelManagerListModelsResult,
  ModelManagerMigrateProgressPayload,
  ModelManagerMigrateProgressPhase,
  ModelManagerMutationResult,
} from './types/model-manager';
