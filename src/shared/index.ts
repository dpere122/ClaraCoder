/**
 * Cross-layer domain types for Electron main, preload, and Angular renderer.
 * No Node or Electron imports — safe to import from any compilation unit.
 */
export type { Workspace, MenuFileCommand, MenuFileCommandAction } from './types/workspace';
export {
  NO_WORKSPACE_SYSTEM_PROMPT_ID,
  isNoWorkspaceSystemPromptId,
  sortRecentWorkspaces,
  isFavoriteWorkspace,
  sortFavoriteWorkspaces,
  sortNonFavoriteWorkspaces,
  setWorkspaceFavorite,
  compactFavoriteOrders,
  reorderFavoriteWorkspaces,
  formatWorkspaceLastOpenedLabel,
} from './types/workspace';
export {
  LEGACY_WORKSPACE_META_DIR,
  WORKSPACE_BUILD_PLANS_DIR,
  WORKSPACE_BUILD_PLANS_REL_DIR,
  WORKSPACE_META_DIR,
  WORKSPACE_SYSTEM_PROMPT_FILE,
  WORKSPACE_SYSTEM_PROMPT_RELATIVE_PATH,
  isWorkspaceSystemPromptRelativePath,
} from './workspace-meta';
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
  ManagedLlamaCacheType,
  ManagedLlamaFlashAttn,
  ManagedLlamaModelFamily,
  ManagedLlamaModelSource,
} from './managed-llama-model-pick';
export {
  CONTEXT_FIT_PRESET_LIST,
  MANAGED_LLAMA_BATCH_MAX,
  MANAGED_LLAMA_BATCH_MIN,
  MANAGED_LLAMA_CACHE_TYPES,
  MANAGED_LLAMA_FLASH_ATTN_MODES,
  MANAGED_LLAMA_NGL_DEFAULT,
  MANAGED_LLAMA_NGL_MAX,
  MANAGED_LLAMA_NGL_MIN,
  buildManagedLlamaChatCommand,
  classifyHubSnapshotGgufPaths,
  ensureManagedLlamaDefaultServerFlags,
  ensureManagedLlamaGemmaReasoningFormat,
  formatReadyDefaultsSummary,
  hubCacheFolderToHfId,
  hubSnapshotManagedPaths,
  inferModelFamilyFromHint,
  inferOptimizationPresetFromModelHint,
  isMmprojGgufFileName,
  languageGgufStem,
  mmprojNameMatchesLanguage,
  isQwenFamily,
  managedLlamaCommandHasCacheRam,
  managedLlamaCommandHasNoHost,
  managedLlamaCommandHasNoMmproj,
  managedLlamaCommandHasNoWebui,
  managedLlamaCommandHasParallel,
  managedLlamaSourceHint,
  managedLlamaSourceDisplayName,
  managedPickerValueForCmd,
  optimizationPresetDefaultsPatch,
  parseCustomManagedContextTokens,
  parseManagedLlamaBatchSize,
  parseManagedLlamaCacheTypeK,
  parseManagedLlamaCacheTypeV,
  parseManagedLlamaContextSize,
  parseManagedLlamaFlashAttn,
  parseManagedLlamaMmproj,
  parseManagedLlamaNgl,
  parseManagedLlamaModelSelection,
  parseManagedLlamaUbatchSize,
  pickPreferredMmprojPath,
  promoteManagedSentinelNglToAuto,
  resolveMmprojPathForManagedGguf,
  resolveMmprojPathForManagedSelection,
  resolveMmprojPathForManagedSource,
  resolveSiblingMmprojFromInventory,
  suggestContextWindowTokens,
  syncBatchSizeInManagedChatCommand,
  syncCacheTypeKInManagedChatCommand,
  syncCacheTypeVInManagedChatCommand,
  syncContextFlagInManagedChatCommand,
  syncFlashAttnInManagedChatCommand,
  syncManagedVisionProjectorInChatCommand,
  syncMmprojFlagInManagedChatCommand,
  syncNglFlagInManagedChatCommand,
  syncNoHostFlagInManagedChatCommand,
  syncNoMmprojFlagInManagedChatCommand,
  syncUbatchSizeInManagedChatCommand,
} from './managed-llama-model-pick';
export type { CudaGpuDevice, GpuOffloadAdvice, ManagedGpuOffloadMode, ParsedGpuOffload } from './managed-llama-gpu-split';
export {
  cudaDeviceListArg,
  formatGpuVramGb,
  parseManagedLlamaGpuOffload,
  recommendGpuOffload,
  shortCudaGpuName,
  syncGpuOffloadInManagedChatCommand,
  syncGpuOffloadFromParsed,
  tensorSplitForGpus,
} from './managed-llama-gpu-split';
export type {
  EmbeddingsLoadStatus,
  EmbeddingsStatusResult,
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
export type { ChatTemplateReasoningCaps } from './chat-template-reasoning';
export {
  GENERIC_REASONING_EFFORT_VALUES,
  QWEN_REASONING_EFFORT_VALUES,
  formatChatTemplateReasoningSummary,
  parseChatTemplateReasoning,
  parseLlamaServerPropsNctx,
  parseLlamaServerPropsReasoning,
} from './chat-template-reasoning';
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
  LlmReasoningEffort,
  LlmReasoningSettingChange,
  AudioTranscriptionConfig,
  AudioTranscriptionProvider,
  AppConfig,
  ChatContainerSize,
  TtsProvider,
  FontFamilyOption,
  SystemFontInfo,
  MonacoWorkspaceEditorSettings,
  MonacoWorkspaceEditorThemeId,
  WorkspaceMonacoEditorScrollState,
  WorkspaceMonacoScrollByWorkspaceId,
  WorkspacePersistedOpenTab,
  WorkspacePersistedEditorGridSlot,
  WorkspacePersistedEditorGridColumn,
  WorkspacePersistedEditorGridLayout,
  WorkspaceOpenTabsState,
  WorkspaceOpenTabsByWorkspaceId,
  WorkspaceToolsConfig,
  McpServerConfig,
  McpServerTransport,
  McpHttpTransport,
  McpHttpAuth,
  McpTrust,
  McpToolDecision,
  McpSecretEntry,
  McpOAuthTokens,
  McpDiscoveredTool,
  McpServerStatus,
  McpHostStatus,
  McpRememberDecision,
  ContextCompressionConfig,
  HealthMonitorConfig,
  ModelManagerConfig,
} from './types/app-config';
export {
  CHAT_CONTAINER_SIZE_OPTIONS,
  LLM_REASONING_EFFORT_OPTIONS,
  LLM_QWEN_REASONING_EFFORT_OPTIONS,
  LLM_THINKING_MODE_OPTIONS,
  llmEffortControlVisible,
  llmEffortSelectOptionsFromCaps,
  llmReasoningSelectChange,
  llmReasoningSelectOptions,
  llmReasoningSelectValue,
  llmThinkingControlVisible,
  CODE_FONT_FAMILY_OPTIONS,
  DEFAULT_CHAT_CONTAINER_SIZE,
  DEFAULT_KOKORO_TTS_VOICE,
  DEFAULT_OPENAI_TRANSCRIBE_MODEL,
  DEFAULT_OPENAI_TTS_BASE_URL,
  DEFAULT_OPENAI_TTS_VOICE,
  DEFAULT_TTS_PROVIDER,
  DEFAULT_WHISPER_MODEL,
  DEFAULT_MONACO_WORKSPACE_EDITOR_THEME_ID,
  MONACO_WORKSPACE_EDITOR_THEME_IDS,
  TTS_SPEECH_SPEED_DEFAULT,
  TTS_SPEECH_SPEED_MAX,
  TTS_SPEECH_SPEED_MIN,
  WHISPER_MODEL_OPTIONS,
  WHISPER_SIZE_REPOS,
  defaultModelForAudioProvider,
  filterDownloadedWhisperModels,
  isWhisperModelId,
  pickWhisperSettingsModel,
  whisperHubCacheDirname,
  UI_FONT_FAMILY_OPTIONS,
  UI_FONT_SIZE_REM_DEFAULT,
  UI_FONT_SIZE_REM_MAX,
  UI_FONT_SIZE_REM_MIN,
  UI_FONT_SIZE_REM_STEP,
  clampUiFontSizeRem,
  normalizeChatContainerSize,
  resolveChatWindowState,
  resolveStartupWorkspaceId,
  shouldOpenHomePageOnStart,
  defaultMonacoWorkspaceEditorSettings,
  getDefaultContextCompression,
  normalizeMonacoWorkspaceEditorSettings,
  normalizeWorkspaceMonacoScrollByWorkspaceId,
  normalizeWorkspaceOpenTabsByWorkspaceId,
  normalizeWorkspaceOpenTabsState,
  normalizePersistedEditorGridLayout,
  persistedWorkspaceOpenTabId,
  WORKSPACE_EDITOR_GRID_MAX_COLUMNS,
  WORKSPACE_EDITOR_GRID_MAX_ROWS,
  pruneRemovedWorkspaceClientState,
  retainRendererWorkspaceOpenTabs,
  SecretValue,
  unwrapSecret,
  createEmptyMcpServer,
} from './types/app-config';
export type { LlamaCppEmbeddingManagedLegacy, LlamaCppManagedLegacy, ShellQuotingPlatform } from './llama-cpp-managed';
export {
  appendChatTemplateFileFlags,
  appendJinjaFlagToManagedChatCommand,
  appendQwenChatTemplateFlagsToManagedChatCommand,
  argvToShellCommandLine,
  buildLlamaServerArgv,
  DEFAULT_MANAGED_LLAMA_CHAT_RUN_COMMAND,
  defaultLlamaCppManaged,
  detectShellQuotingPlatform,
  isLegacyLlamaCppManagedShape,
  managedLlamaCommandHasJinja,
  migrateLegacyLlamaCppManagedToCommands,
  parseHostFromLlamaCommand,
  parseManagedLlamaChatTemplateFile,
  prepareManagedLlamaShellCommand,
  shellQuoteArg,
  syncChatTemplateFileInManagedChatCommand,
} from './llama-cpp-managed';
export {
  countLlmModels,
  findLlmModelLocation,
  findManagedLocalLlamaLocation,
  flattenLlmProvidersToConnections,
  mergeLlmProviderModel,
  patchLlmModelProfile,
  resolveActiveLlmConnection,
} from './llm-providers';
export type { LlmOptimizationPresetMeta } from './types/llm-presets';
export {
  LLM_OPTIMIZATION_PRESET_LIST,
  GEMMA_PRESET_DEFAULTS,
  optimizationPresetsForProvider,
  outerAgentBriefEnabled,
  QWEN_PRESET_DEFAULTS,
} from './types/llm-presets';
export { inferContextWindowTokens, isGemmaFamily, resolveContextWindowTokens } from './model-context';
export {
  PINNED_LLAMA_CPP_LOCAL_PROVIDER_ID,
  PINNED_LM_STUDIO_PROVIDER_ID,
  PINNED_LLAMA_SERVER_URL_PROVIDER_ID,
  PINNED_OPENROUTER_PROVIDER_ID,
  isPinnedLmStudioProviderId,
  isPinnedLlamaCppLocalProviderId,
  isPinnedLlamaServerUrlProviderId,
  isPinnedOpenRouterProviderId,
  isPinnedLlmSourceId,
} from './llm-provider-ids';
export { lmStudioOpenAiBaseUrlToRestOrigin } from './lm-studio-url';
export type { LmStudioModelCard, LmStudioListModelsResult, LmStudioMutationResult } from './lm-studio-ipc';
export type { OpenRouterCatalogModel, OpenRouterListModelsResult, OpenRouterReasoningInfo } from './openrouter-ipc';
export { openRouterReasoningCaps } from './openrouter-ipc';
export { coerceLmStudioContextTokens, effectiveLmStudioContextTokens } from './lm-studio-ipc';
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
  NUDGE_STREAM_TAG,
  REASONING_AUXILIARY_STREAM_TAG,
  PLANNER_STREAM_TAG,
  delegatedStreamPartsForDisplay,
  emptyPrimaryAssistantFallbackMessage,
  isClaraOuterBriefStreamTag,
  isNudgeStreamTag,
  isReasoningAuxiliaryStreamTag,
  isPrimaryAssistantStreamTag,
  isShellStyleToolStreamTag,
  isHitlTrailStreamTag,
  isToolTrailStatusStreamTag,
  isToolLikeStreamTag,
  isInFlightToolPart,
  joinAllStreamPartTexts,
  joinPrimaryAssistantStreamText,
  normalizeReasoningStreamPart,
  normalizeStreamPart,
  normalizeStreamTag,
  persistedReasoningStreams,
  reasoningStreamPartsForDisplay,
  multiplexAuxiliaryStreamTimeline,
  buildTurnFeed,
  isActiveLiveThought,
  isActiveLiveNudge,
  turnFeedScrollKey,
  otherDelegatedStreamPartsForDisplay,
  persistedAuxiliaryStreamTimeline,
  primaryAssistantTextFromParts,
  clearPrimaryStreamParts,
  promotePrimaryAheadOfToolToReasoning,
  promotePrimaryToNudgeParts,
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
export type { PersistedAssistantStreamFields, TurnFeedItem } from './stream-parts';
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
  AppendConversationFileJournalRequest,
  ConversationFileJournalEntry,
  ConversationFileJournalOp,
  ConversationFileJournalTreeEntry,
  ConversationTimelineInvertAction,
  RestoreConversationTimelineRequest,
  RestoreConversationTimelineResult,
} from './types/conversation-timeline';
export {
  canRestoreToUserMessage,
  fallbackJournalFromMessages,
  invertJournalEntries,
  isConversationFileJournalOp,
  journalPreviewPaths,
  journalUserIdsToInvert,
  lastUserMessageId,
  parseFileJournalSsePayload,
  resolveRestoreUserIndex,
  truncateMessagesAfterUserTurn,
} from './conversation-timeline';
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
export type { LspDashboardServerEntry, LspDashboardStatus, LspLifecyclePhase } from './types/lsp-dashboard';
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
export type { AcceptCommandAction, AcceptCommandFinishedEvent, AcceptCommandPayload } from './types/accept-command';
export {
  ACCEPT_COMMAND_KIND_ADMIN_ELEVATION,
  ACCEPT_COMMAND_KIND_ADMIN_ELEVATION_TOOL,
  createAdminElevationAcceptPayload,
  isAdminElevationKind,
} from './types/accept-command';
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
export type { ThemeProposalAction, ThemeProposalFinishedEvent, ThemeProposalPayload } from './types/theme-proposal';
export { isThemeProposalPayload } from './types/theme-proposal';
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
  EnsureWorkspaceSystemPromptResult,
} from './types/workspace-context';
export type {
  HealthLogLevel,
  HealthLogRecord,
  HealthMetricsSnapshot,
  GpuInfo,
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
  DEPENDENCY_COMPONENTS,
  DEPENDENCY_IDS,
  DEPENDENCY_LABELS,
  DEPENDENCY_DESCRIPTIONS,
  DEPENDENCY_SIZE_HINTS,
  LLAMA_SERVER_VARIANTS,
  LLAMA_SERVER_VARIANT_LABELS,
  defaultDependencyCatalog,
  dependencyComponents,
} from './types/dependencies';
