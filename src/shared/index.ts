/**
 * Cross-layer domain types for Electron main, preload, and Angular renderer.
 * No Node or Electron imports — safe to import from any compilation unit.
 */
export type { Workspace } from './types/workspace';
export {
  APP_BACKEND_INTERPRETER_ID,
  RUNTIME_VENV_INTERPRETER_ID,
} from './python-interpreter-ids';
export type { ComposerBackendMode, ComposerRunMode } from './types/composer-mode';
export {
  COMPOSER_RUN_MODES,
  COMPOSER_RUN_MODE_LABELS,
  DEFAULT_COMPOSER_RUN_MODE,
  composerApplyMode,
  composerModeForBackend,
} from './types/composer-mode';
export { looksLikeLlamaModelDownload, managedLlamaCmdUsesHfRemoteModel } from './llama-model-download';
export type {
  ContextFitPresetId,
  ContextFitPresetMeta,
  ManagedLlamaCheckpointMode,
  ManagedLlamaCheckpointSettings,
  ManagedLlamaModelFamily,
  ManagedLlamaModelSource,
} from './managed-llama-model-pick';
export {
  CONTEXT_FIT_PRESET_LIST,
  MANAGED_LLAMA_CHECKPOINT_DISABLED,
  buildManagedLlamaChatCommand,
  formatReadyDefaultsSummary,
  hubCacheFolderToHfId,
  inferModelFamilyFromHint,
  inferOptimizationPresetFromModelHint,
  isQwenFamily,
  managedLlamaSourceHint,
  optimizationPresetDefaultsPatch,
  parseManagedLlamaCheckpointSettings,
  parseManagedLlamaModelSelection,
  suggestContextWindowTokens,
  syncCheckpointFlagsInManagedChatCommand,
  syncContextFlagInManagedChatCommand,
} from './managed-llama-model-pick';
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
  ChatContainerSize,
  TtsProvider,
  FontFamilyOption,
  SystemFontInfo,
  MonacoWorkspaceEditorSettings,
  MonacoWorkspaceEditorThemeId,
  WorkspaceMonacoEditorScrollState,
  WorkspaceMonacoScrollByWorkspaceId,
  WorkspaceToolsConfig,
  ContextCompressionConfig,
  HealthMonitorConfig,
  ModelManagerConfig,
} from './types/app-config';
export {
  CHAT_CONTAINER_SIZE_OPTIONS,
  CODE_FONT_FAMILY_OPTIONS,
  DEFAULT_CHAT_CONTAINER_SIZE,
  DEFAULT_KOKORO_TTS_VOICE,
  DEFAULT_OPENAI_TTS_BASE_URL,
  DEFAULT_OPENAI_TTS_VOICE,
  DEFAULT_TTS_PROVIDER,
  MONACO_WORKSPACE_EDITOR_THEME_IDS,
  TTS_SPEECH_SPEED_DEFAULT,
  TTS_SPEECH_SPEED_MAX,
  TTS_SPEECH_SPEED_MIN,
  UI_FONT_FAMILY_OPTIONS,
  UI_FONT_SIZE_REM_DEFAULT,
  UI_FONT_SIZE_REM_MAX,
  UI_FONT_SIZE_REM_MIN,
  UI_FONT_SIZE_REM_STEP,
  clampUiFontSizeRem,
  normalizeChatContainerSize,
  defaultMonacoWorkspaceEditorSettings,
  getDefaultContextCompression,
  normalizeMonacoWorkspaceEditorSettings,
  normalizeWorkspaceMonacoScrollByWorkspaceId,
} from './types/app-config';
export { GEMMA4_CHAT_TEMPLATE_FILENAME } from './gemma-template';
export { QWEN_INFERENCE_CHAT_TEMPLATE_FILENAME } from './qwen-template';
export type { LlamaCppEmbeddingManagedLegacy, LlamaCppManagedLegacy, ShellQuotingPlatform } from './llama-cpp-managed';
export {
  appendChatTemplateFileFlags,
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
  isHitlTrailStreamTag,
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
  clearPrimaryStreamParts,
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
  RUN_COMMAND_STREAM_TAG_PREFIX,
  isRunCommandStreamTag,
  SHELL_STYLE_TOOL_STREAM_TAGS,
  shellDelegatedStreamPartsForDisplay,
  shouldIgnoreWhitespaceOnlyModelChunkDuringTool,
  streamPlainOneLine,
  hitlTrailStreamTag,
  toolTrailStatusIdFromStreamTag,
  toolTrailStatusStreamTag,
  HITL_TRAIL_STREAM_PREFIX,
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
  hitlTrailItemsToStreamParts,
  hitlTrailKindLabel,
  hitlTrailPanelTitle,
  hitlTrailRowKindText,
  hitlTrailStatusLabel,
  mergeHitlTrailIntoAuxiliaryTimeline,
} from './hitl-trail';
export type { HitlTrailArtifact, HitlTrailItem, HitlTrailKind } from './hitl-trail';
export type { LspDashboardServerEntry, LspDashboardStatus } from './types/lsp-dashboard';
export type { LspEditorDiagnostic, LspEditorDiagnosticsPayload } from './types/lsp-editor-diagnostics';
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
export type {
  PlanConfirmFileChange,
  PlanConfirmPayload,
  PlanConfirmResolvedQuestion,
  PlanFileOperation,
} from './types/plan-confirm';
export {
  normalizePlanConfirmFileChange,
  normalizePlanConfirmFilesToChange,
} from './types/plan-confirm';
export type {
  AgentQuestionPayload,
  QuestionAnswer,
  QuestionOption,
  QuestionPrompt,
} from './types/agent-question';
export type { BuildPlanChunkPayload, BuildPlanOpenPayload, BuildPlanStreamEndPayload } from './types/build-plan';
export type { CopyConfirmItem, CopyConfirmPayload } from './types/copy-confirm';
export type { DeleteConfirmEntry, DeleteConfirmPayload } from './types/delete-confirm';
export type {
  StagedTransferBatchPayload,
  StagedTransferFileResolution,
} from './types/staged-transfer-batch';
export type {
  WorkspaceContextState,
  WorkspaceChangeKind,
  WorkspaceFilesChangedPayload,
  WorkspaceChangeRecord,
  WorkspaceContextSyncExtras,
  WorkspaceFileChangesForSync,
  PythonInterpreterListItem,
  WorkspaceSystemPromptStatus,
  WorkspaceSystemPromptMutationResult,
} from './types/workspace-context';
export type {
  HealthLogLevel,
  HealthLogRecord,
  HealthMetricsSnapshot,
  RuntimeHealthSnapshot,
} from './types/health';
export {
  DEFAULT_THUMB_MAX_EDGE,
  computeThumbDimensions,
  parseThumbMaxEdge,
} from './nemo-asset-thumb';
export type {
  HuggingFaceModelFile,
  HuggingFaceModelSearchItem,
  ModelManagerEntryKind,
  ModelManagerFileEntry,
  ModelManagerHfFilesResult,
  ModelManagerHfSearchResult,
  ModelManagerListModelsResult,
  ModelManagerMutationResult,
  HfDownloadId,
  HfDownloadPhase,
  HfDownloadProgressEvent,
  ModelManagerDownloadHfResult,
} from './types/model-manager';
export type {
  DependencyActionResult,
  DependencyId,
  DependencyInfo,
  DependencyProgressEvent,
  DependencyProgressPhase,
  DependencyState,
  LlamaServerVariant,
} from './types/dependencies';
export {
  DEPENDENCY_IDS,
  DEPENDENCY_LABELS,
  DEPENDENCY_DESCRIPTIONS,
  DEPENDENCY_SIZE_HINTS,
  LLAMA_SERVER_VARIANTS,
  LLAMA_SERVER_VARIANT_LABELS,
  defaultDependencyCatalog,
} from './types/dependencies';
