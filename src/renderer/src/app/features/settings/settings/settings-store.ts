import { Injectable, afterNextRender, effect, inject, Injector, computed, signal, untracked } from '@angular/core';
import { NgxSpinnerService } from 'ngx-spinner';
import { Subscription } from 'rxjs';
import { DEFAULT_SCREENSHOT_RETENTION, normalizeScreenshotRetention, type ScreenshotRetentionSettings } from '@shared/screenshot-retention';
import type {
  AppConfig,
  AudioTranscriptionConfig,
  AudioTranscriptionProvider,
  ChatContainerSize,
  ChatThinkingDisplay,
  FontFamilyOption,
  HuggingFaceModelFile,
  HuggingFaceModelSearchItem,
  HfDownloadId,
  HfDownloadProgressEvent,
  LlamaCppManaged,
  LlmConnectionConfig,
  LlmModelProfile,
  LlmOptimizationPreset,
  LlmProviderConfig,
  LmStudioModelCard,
  LmStudioSettings,
  OpenAiCompatEndpoint,
  OpenAiCompatModel,
  OpenAiCompatSettings,
  OpenAiCompatTestResult,
  OpenRouterCatalogModel,
  AnthropicCatalogModel,
  ModelManagerFileEntry,
  ModelManagerHfDetailsResult,
  SecretStorageMode,
  MonacoWorkspaceEditorSettings,
  MonacoWorkspaceEditorThemeId,
  SystemFontInfo,
  Workspace,
  WorkspaceToolsConfig,
  ContextCompressionConfig,
  TtsProvider,
  CudaGpuDevice,
  ManagedGpuOffloadMode,
} from '@shared/index';
import {
  CHAT_CONTAINER_SIZE_OPTIONS,
  CHAT_THINKING_DISPLAY_OPTIONS,
  CODE_FONT_FAMILY_OPTIONS,
  DEFAULT_CHAT_CONTAINER_SIZE,
  DEFAULT_CHAT_THINKING_DISPLAY,
  DEFAULT_MANAGED_LLAMA_CHAT_RUN_COMMAND,
  uniqueManagedLlamaSourceName,
  getDefaultContextCompression,
  maxContextCompressionTarget,
  DEFAULT_KOKORO_TTS_VOICE,
  DEFAULT_OPENAI_TRANSCRIBE_MODEL,
  DEFAULT_OPENAI_TTS_BASE_URL,
  DEFAULT_OPENAI_TTS_VOICE,
  DEFAULT_TTS_PROVIDER,
  DEFAULT_WHISPER_MODEL,
  MONACO_WORKSPACE_EDITOR_THEME_IDS,
  TTS_SPEECH_SPEED_DEFAULT,
  TTS_SPEECH_SPEED_MAX,
  TTS_SPEECH_SPEED_MIN,
  filterDownloadedWhisperModels,
  isWhisperModelId,
  pickWhisperSettingsModel,
  UI_FONT_FAMILY_OPTIONS,
  UI_FONT_SIZE_REM_DEFAULT,
  UI_FONT_SIZE_REM_MAX,
  UI_FONT_SIZE_REM_MIN,
  UI_FONT_SIZE_REM_STEP,
  buildManagedLlamaChatCommand,
  carryCustomLlamaFlags,
  clampUiFontSizeRem,
  defaultMonacoWorkspaceEditorSettings,
  defaultLlamaCppManaged,
  detectShellQuotingPlatform,
  effectiveLmStudioContextTokens,
  lmStudioLoadOptions,
  lmStudioRunningConfigDiffers,
  normalizeLmStudioSettings,
  normalizeOpenAiCompatSettings,
  countLlmModels,
  defaultLlmModelId,
  findLlmModelLocation,
  hubCacheFolderToHfId,
  inferContextWindowTokens,
  inferModelFamilyFromHint,
  inferOptimizationPresetFromModelHint,
  isDraftSidecarGgufFileName,
  isMmprojGgufFileName,
  isMtpCompanionGgufFileName,
  LOCAL_DRAFT_MODEL_FLAG_NAMES,
  managedLlamaKvCacheWeight,
  managedLlamaCommandHasNoHost,
  managedLlamaCommandHasNoMmproj,
  managedLlamaModelLabel,
  managedLlamaSourceDisplayName,
  managedLlamaSourceHint,
  managedMtpHead,
  managedPickerValueForCmd,
  mergeLlmProviderModel,
  normalizeChatContainerSize,
  normalizeChatThinkingDisplay,
  normalizeMonacoWorkspaceEditorSettings,
  normalizeWebSearchEngines,
  optimizationPresetDefaultsPatch,
  optimizationPresetsForProvider,
  parseCustomManagedContextTokens,
  parseManagedLlamaBatchSize,
  parseManagedLlamaCacheTypeK,
  parseManagedLlamaCacheTypeV,
  parseManagedLlamaContextSize,
  parseManagedLlamaFlashAttn,
  parseManagedLlamaMmproj,
  parseManagedLlamaNgl,
  parseManagedLlamaModelSelection,
  parseManagedLlamaGpuOffload,
  parseManagedLlamaChatTemplateFile,
  parseManagedLlamaUbatchSize,
  mmprojNameMatchesLanguage,
  readLlamaFlagValue,
  resolveMmprojPathForManagedSelection,
  resolveMmprojPathForManagedSource,
  resolveMtpPathForManagedGguf,
  promoteManagedSentinelNglToAuto,
  recommendGpuOffload,
  formatGpuVramGb,
  shortCudaGpuName,
  syncBatchSizeInManagedChatCommand,
  syncCacheTypeKInManagedChatCommand,
  syncCacheTypeVInManagedChatCommand,
  syncFlashAttnInManagedChatCommand,
  syncNglFlagInManagedChatCommand,
  syncNoHostFlagInManagedChatCommand,
  syncManagedVisionProjectorInChatCommand,
  syncChatTemplateFileInManagedChatCommand,
  syncGpuOffloadInManagedChatCommand,
  syncGpuOffloadFromParsed,
  syncUbatchSizeInManagedChatCommand,
  tunePickedManagedChatCommand,
  withoutAutoTunedFlags,
  isPinnedLlmSourceId,
  isPinnedLmStudioProviderId,
  isPinnedLlamaServerUrlProviderId,
  isPinnedOpenRouterProviderId,
  isPinnedAnthropicProviderId,
  OPENROUTER_DEFAULT_BASE_URL,
  type GgufProfile,
  type GpuVramCardUsage,
  type ManagedLlamaModelSource,
  setWorkspaceFavorite,
} from '@shared/index';
import {
  SecretValue,
  createEmptyMcpServer,
  unwrapSecret,
  type McpHostStatus,
  type McpServerConfig,
  type McpToolDecision,
} from '@shared/index';
import { ElectronService } from '../../../core/electron.service';
import { ThemedConfirmDialogService } from '../../../shared/themed-confirm-dialog/themed-confirm-dialog.service';
import { ThemedPromptDialogService } from '../../../shared/themed-prompt-dialog/themed-prompt-dialog.service';
import {
  activeStreamWorkspaceSwitchPrompt,
  discardSettingsChangesPrompt,
  unsavedWorkspaceSwitchPrompt,
} from '../../../shared/themed-confirm-dialog/format-unsaved-workspace-detail';
import {
  customModelDeletePrompt,
  localSourceRemovePrompt,
  workspaceRemovePrompt,
} from '../../../shared/themed-confirm-dialog/format-delete-prompt';
import { DEFAULT_THEME_ID, resolveLegacyThemeId } from '@shared/theme';
import { applyAppFontOverrides } from '../../../core/theme/app-font-overrides';
import { ThemeEngineService } from '../../../core/theme/theme-engine.service';
import { isTutorialProgressSupported } from '@shared/types/tutorial';
import { TutorialCoordinator } from '../../tutorial/tutorial-coordinator';
import { SettingsThemesStore } from '../settings-themes/settings-themes-store';
import { themesCategoryFromSubTabId } from './settings-tabs';
import { VOICE_OPTIONS } from '../../speech/speech-module/speech-module';
import {
  SETTINGS_SUB_TAB_CATALOG,
  SETTINGS_TABS,
  initialSettingsTab,
  isSettingsTab,
  type SettingsSubTabEntry,
  type SettingsTab,
} from './settings-tabs';

const PLAN_PROGRESS_SPINNER_TYPE = 'line-spin-fade' as const;
const CACHE_DETECT_SPINNER_TYPE = 'ball-pulse-sync' as const;

const CLOSE_SAVE_SPINNER = {
  fullScreen: false as const,
  bdColor: 'rgba(0,0,0,0)',
  size: 'small' as const,
  color: 'var(--bs-btn-color, #fff)',
  type: PLAN_PROGRESS_SPINNER_TYPE,
};

const CACHE_DETECT_SPINNER = {
  fullScreen: false as const,
  bdColor: 'rgba(0,0,0,0)',
  size: 'small' as const,
  color: 'var(--t-primary)',
  type: CACHE_DETECT_SPINNER_TYPE,
};

const TALK_SILENCE_THRESHOLD_MIN = 0.5;
const TALK_SILENCE_THRESHOLD_MAX = 5;
const TALK_SILENCE_THRESHOLD_STEP = 0.5;

function clampTtsSpeechSpeed(raw: unknown): number {
  const n = typeof raw === 'number' && !Number.isNaN(raw) ? raw : TTS_SPEECH_SPEED_DEFAULT;
  const c = Math.min(TTS_SPEECH_SPEED_MAX, Math.max(TTS_SPEECH_SPEED_MIN, n));
  return +c.toFixed(2);
}

/** Compare OpenAI-compatible ``…/v1`` bases for equality (trailing slashes optional). */
function openAiV1BasesEquivalent(a: string, b: string): boolean {
  const norm = (raw: string) => {
    let s = (raw || '').trim().replace(/\/+$/, '');
    if (!s.toLowerCase().endsWith('/v1')) {
      s = `${s}/v1`;
    }
    return s.toLowerCase();
  };
  return norm(a) === norm(b);
}

/** Strip a trailing .gguf / .ggml extension (case-insensitive) for rename pre-fill. */
function stripModelExtension(fileName: string): string {
  const lower = (fileName || '').toLowerCase();
  if (lower.endsWith('.gguf')) {
    return fileName.slice(0, -'.gguf'.length);
  }
  if (lower.endsWith('.ggml')) {
    return fileName.slice(0, -'.ggml'.length);
  }
  return fileName;
}

/** Return the lowercased model extension (e.g. '.gguf', '.ggml') or '' if none. */
function modelExtension(fileName: string): string {
  const lower = (fileName || '').toLowerCase();
  if (lower.endsWith('.gguf')) {
    return '.gguf';
  }
  if (lower.endsWith('.ggml')) {
    return '.ggml';
  }
  return '';
}

const MONACO_EDITOR_THEME_LABELS: Record<MonacoWorkspaceEditorThemeId, string> = {
  'follow-app': 'Follow app theme',
  'vs-dark': 'VS Dark',
  vs: 'VS Light',
  'hc-black': 'High contrast dark',
  'hc-light': 'High contrast light',
};

interface TalkAudioInputDevice {
  deviceId: string;
  label: string;
}

/** Hub search file-type filter on open and after Reset filters. */
const DEFAULT_HF_FILE_TYPE = 'gguf';

/** What the Model Manager detail panel shows. */
export type ModelManagerSelection = { kind: 'hf'; id: string } | { kind: 'local'; path: string };

export type LmStudioStatus = 'idle' | 'checking' | 'connected' | 'stale' | 'offline';

export interface LmStudioConnection {
  /** Base URL that was checked; a different draft URL makes the connection stale. */
  baseUrl: string;
  origin: string;
  source: 'v1' | 'v0';
}

@Injectable()
export class SettingsStore {
  private readonly ngxSpinner = inject(NgxSpinnerService);
  private readonly inj = inject(Injector);
  private destroyed = false;

  /** Shown in managed llama-server tips and placeholders (must match Electron substitution token). */
  readonly managedLlamaPortToken = '{{PORT}}';
  readonly settingsDirty = signal(false);
  /** Which footer action is currently persisting config (`null` when idle). */
  readonly settingsSaveAction = signal<'apply' | 'ok' | null>(null);
  readonly settingsSaving = computed(() => this.settingsSaveAction() !== null);
  readonly settingsSaveSpinnerName = `settings-save-${Math.random().toString(36).slice(2, 10)}`;
  readonly planProgressSpinnerType = PLAN_PROGRESS_SPINNER_TYPE;
  readonly localModelsSpinnerName = `settings-local-models-${Math.random().toString(36).slice(2, 10)}`;
  readonly localModelDropdownSpinnerName = `settings-local-model-dropdown-${Math.random().toString(36).slice(2, 10)}`;
  readonly hfSearchSpinnerName = `settings-hf-search-${Math.random().toString(36).slice(2, 10)}`;
  readonly whisperModelDropdownSpinnerName = `settings-whisper-model-dropdown-${Math.random().toString(36).slice(2, 10)}`;
  readonly cacheDetectSpinnerType = CACHE_DETECT_SPINNER_TYPE;
  readonly modelManagerLocalLoading = signal(false);
  /** Inventory state is kept separately from status text, which other Model Manager actions also use. */
  private readonly localInventoryResult = signal<'unknown' | 'ok' | 'error'>('unknown');
  private readonly localInventoryInflight = signal(0);
  private localInventoryRequestGen = 0;
  readonly whisperModelsLoading = signal(false);
  private whisperRefreshInflight = 0;
  /**
   * Default chat command for newly added managed ``llama-server`` sources (not the pinned local row).
   */
  private static readonly newManagedLlamacppChatCommand = DEFAULT_MANAGED_LLAMA_CHAT_RUN_COMMAND;
  readonly selectedSettingsTab = signal<SettingsTab>(initialSettingsTab());
  readonly tabs = SETTINGS_TABS;
  /** Kokoro voice ids for {@link AudioTranscriptionConfig.ttsVoice} (same list as chat TTS). */
  readonly ttsVoiceChoices = VOICE_OPTIONS;
  private readonly themeEngine = inject(ThemeEngineService);
  private readonly tutorial = inject(TutorialCoordinator);
  /** Theme editing state (Settings → Themes); participates in Apply / OK through {@link attach}. */
  readonly themes$ = inject(SettingsThemesStore);
  /** Selectable themes (built-ins + user library) as `{ id, label }` rows for pickers. */
  get themes(): { id: string; label: string }[] {
    return this.themeEngine.library().map((t) => ({ id: t.id, label: t.name }));
  }
  readonly monacoEditorThemeSelectOptions = MONACO_WORKSPACE_EDITOR_THEME_IDS.map((id) => ({
    id,
    label: MONACO_EDITOR_THEME_LABELS[id],
  }));
  /** Curated App font choices (Settings → General → Chat appearance). */
  readonly uiFontFamilyOptions = UI_FONT_FAMILY_OPTIONS;
  /** Curated Code font choices (Settings → General → Chat appearance). */
  readonly codeFontFamilyOptions = CODE_FONT_FAMILY_OPTIONS;
  /** OS-installed fonts (from `list-system-fonts` IPC), shown under "System fonts" in both pickers. */
  readonly systemFonts = signal<SystemFontInfo[]>([]);
  readonly systemFontOptions = computed<FontFamilyOption[]>(() =>
    this.systemFonts().map((f) => ({
      label: f.monospace ? `${f.name} (monospace)` : f.name,
      stack: `${f.familyName}, ${f.monospace ? 'monospace' : 'sans-serif'}`,
    })),
  );
  readonly settingsSubTabCatalog = SETTINGS_SUB_TAB_CATALOG;
  readonly selectedSubTabs = signal<Partial<Record<SettingsTab, string>>>({});
  readonly workspaces = signal<Workspace[]>([]);
  readonly currentWorkspace = signal<Workspace | null>(null);
  readonly themeId = signal(DEFAULT_THEME_ID);
  readonly llmProviders = signal<LlmProviderConfig[]>([]);
  /** IDs in the latest authoritative config, not the editable Settings draft. */
  private readonly persistedSourceIds = signal<ReadonlySet<string> | null>(null);
  readonly activeLlmModelId = signal('default-lmstudio');
  readonly selectedModelId = signal<string | null>(null);
  readonly audioProvider = signal<AudioTranscriptionProvider>('whisper');
  readonly audioBaseUrl = signal('');
  readonly audioModel = signal(DEFAULT_WHISPER_MODEL);
  readonly audioApiKey = signal('');
  readonly whisperDownloadedModels = signal<string[]>([]);
  readonly whisperModelOptions = computed(() =>
    filterDownloadedWhisperModels(this.whisperDownloadedModels()),
  );
  readonly talkInputDeviceId = signal('default');
  readonly talkSilenceThresholdSeconds = signal(2);
  readonly talkAudioInputDevices = signal<TalkAudioInputDevice[]>([]);
  readonly talkAudioInputsLoadError = signal('');
  readonly chatFontSizeRem = signal(0.9);
  readonly chatContainerSize = signal<ChatContainerSize>(DEFAULT_CHAT_CONTAINER_SIZE);
  readonly chatContainerSizeOptions = CHAT_CONTAINER_SIZE_OPTIONS;
  readonly chatThinkingDisplay = signal<ChatThinkingDisplay>(DEFAULT_CHAT_THINKING_DISPLAY);
  readonly chatThinkingDisplayOptions = CHAT_THINKING_DISPLAY_OPTIONS;
  readonly uiFontSizeRem = signal(UI_FONT_SIZE_REM_DEFAULT);
  /** App-wide UI font override (CSS font-family value); empty = theme default. */
  readonly uiFontFamily = signal('');
  /** Code font override (CSS font-family value); empty = theme default. Overrides Monaco's own fontFamily. */
  readonly codeFontFamily = signal('');
  readonly monacoWorkspaceEditor = signal<MonacoWorkspaceEditorSettings>(defaultMonacoWorkspaceEditorSettings());
  readonly ttsVoice = signal(DEFAULT_KOKORO_TTS_VOICE);
  readonly ttsSpeechSpeed = signal(TTS_SPEECH_SPEED_DEFAULT);
  readonly ttsProvider = signal<TtsProvider>(DEFAULT_TTS_PROVIDER);
  readonly ttsBaseUrl = signal(DEFAULT_OPENAI_TTS_BASE_URL);
  readonly ttsApiKey = signal('');
  readonly ttsDefaultInstructions = signal('');
  readonly editToolsMode = signal<'standard' | 'strict'>('standard');
  readonly mcpServers = signal<McpServerConfig[]>([]);
  readonly mcpStatus = signal<McpHostStatus | null>(null);
  readonly mcpStatusError = signal('');
  readonly mcpOauthBusyId = signal('');
  readonly mcpEnabledCount = computed(() => this.mcpServers().filter((server) => server.enabled).length);
  readonly maxFileReadLines = signal(400);
  readonly maxSearchResults = signal(40);
  readonly defaultWorkspaceEncoding = signal('utf-8');
  readonly defaultWorkspaceNewline = signal<'lf' | 'crlf' | 'preserve'>('lf');
  readonly allowStagingOverlayCommands = signal(false);
  readonly commandLineExplainStep = signal(false);
  readonly exposeAllWorkspaceFiles = signal(false);
  readonly allowWebAccess = signal(false);
  readonly searxngBaseUrl = signal('');
  readonly webSearchProvider = signal<'auto' | 'internal' | 'searxng'>('auto');
  readonly webSearchEngines = signal<string[]>([]);
  readonly webSearchUserAgent = signal('');
  readonly webSearchCooldownSeconds = signal(300);
  readonly screenshotRetention = signal<ScreenshotRetentionSettings>({ ...DEFAULT_SCREENSHOT_RETENTION });
  readonly extraUserPath = signal('');
  readonly enableAgentFormatters = signal(false);
  readonly confirmMove = signal(true);
  /** Null follows the saved tour, so finishing or dismissing it elsewhere also unticks the box. */
  private readonly tutorialEnabledDraft = signal<boolean | null>(null);
  readonly tutorialEnabled = computed(() => this.tutorialEnabledDraft() ?? this.tutorial.hasUnresolved());
  /** Progress saved by a newer release stays read-only here. */
  readonly tutorialToggleAvailable = computed(() => {
    const snapshot = this.tutorial.snapshot();
    return !!snapshot && isTutorialProgressSupported(snapshot.progress);
  });
  readonly contextCompressionEnabled = signal(true);
  readonly contextCompressionTriggerRatio = signal(0.8);
  readonly contextCompressionTargetRatio = signal(0.5);
  readonly modelManagerCustomDir = signal('');
  readonly modelManagerHfToken = signal('');
  /** How config secrets (the HF token) land on disk; null until main reports it. */
  readonly modelManagerSecretStorage = signal<SecretStorageMode | null>(null);
  readonly modelManagerCustomModels = signal<ModelManagerFileEntry[]>([]);
  readonly modelManagerHfQuery = signal('');
  readonly modelManagerHfRawResults = signal<HuggingFaceModelSearchItem[]>([]);
  readonly modelManagerHfPage = signal(0);
  readonly modelManagerHfHasMore = signal(false);
  readonly modelManagerHfTotalPages = signal(0);
  readonly modelManagerHfWindowStart = signal(0);
  readonly modelManagerHfPageSize = 30;

  /** Filter panel state for HF search. */
  readonly modelManagerHfFiltersOpen = signal(false);
  /**
   * Selected file-type tag (server-side HF `filter` param). '' = all file types. Defaults to GGUF,
   * the only format managed llama-server can run.
   */
  readonly modelManagerHfFileType = signal(DEFAULT_HF_FILE_TYPE);
  /** Minimum downloads threshold (client-side filter). 0 = any. */
  readonly modelManagerHfMinDownloads = signal(0);
  /** Minimum likes threshold (client-side filter). 0 = any. */
  readonly modelManagerHfMinLikes = signal(0);

  /** Displayed results after applying client-side numeric filters. */
  readonly modelManagerHfResults = computed<HuggingFaceModelSearchItem[]>(() => {
    const minDl = this.modelManagerHfMinDownloads();
    const minLikes = this.modelManagerHfMinLikes();
    const raw = this.modelManagerHfRawResults();
    if (minDl <= 0 && minLikes <= 0) {
      return raw;
    }
    return raw.filter(
      (m) => m.downloads >= minDl && m.likes >= minLikes,
    );
  });
  readonly modelManagerHfPageWindowSize = 10;

  /** File-type filter options (server-side HF `filter` tag). */
  readonly hfFileTypeOptions: readonly { value: string; label: string }[] = [
    { value: '', label: 'All' },
    { value: 'gguf', label: 'GGUF' },
  ];
  /** Minimum-download threshold options (client-side filter). */
  readonly hfMinDownloadsOptions: readonly number[] = [0, 100, 1_000, 10_000, 100_000, 1_000_000];
  /** Minimum-likes threshold options (client-side filter). */
  readonly hfMinLikesOptions: readonly number[] = [0, 10, 100, 1_000, 10_000];

  readonly modelManagerHfPageNumbers = computed(() => {
    const start = this.modelManagerHfWindowStart();
    const totalPages = this.modelManagerHfTotalPages();
    if (totalPages <= 0) {
      return [];
    }
    const lastPage = totalPages - 1;
    const end = Math.min(start + this.modelManagerHfPageWindowSize - 1, lastPage);
    const pages: number[] = [];
    for (let page = start; page <= end; page += 1) {
      pages.push(page);
    }
    return pages;
  });
  readonly modelManagerStatus = signal('');
  readonly modelManagerBusy = signal(false);
  readonly modelManagerHfBusy = signal(false);

  /** Model shown in the Model Manager detail panel: a Hub repo, or a local file / hub folder by path. */
  readonly modelManagerSelection = signal<ModelManagerSelection | null>(null);
  /** Hub repo details (owner profiles, GGUF header facts) per repo id. */
  readonly modelManagerHfDetailsById = signal<Record<string, ModelManagerHfDetailsResult>>({});
  readonly modelManagerHfDetailsBusyById = signal<Record<string, boolean>>({});
  /** GGUF quant files discovered per repo id. */
  readonly modelManagerHfFilesByRepo = signal<Record<string, HuggingFaceModelFile[]>>({});
  /** Per-repo loading state for the file/quant fetch. */
  readonly modelManagerHfFilesBusyByRepo = signal<Record<string, boolean>>({});
  /** Per-repo error message for the file/quant fetch. */
  readonly modelManagerHfFilesErrorByRepo = signal<Record<string, string>>({});

  /** In-flight HF quant downloads keyed by ``${repoId}/${fileName}``. */
  readonly modelManagerHfDownloads = signal<
    Record<HfDownloadId, { repoId: string; fileName: string; receivedBytes: number; totalBytes: number | null }>
  >({});
  /** Quants that finished downloading (value = absolute path of the local GGUF). */
  readonly modelManagerHfDownloaded = signal<Record<HfDownloadId, string>>({});
  readonly uiFontSizeRemMin = UI_FONT_SIZE_REM_MIN;
  readonly uiFontSizeRemMax = UI_FONT_SIZE_REM_MAX;
  readonly uiFontSizeRemDefault = UI_FONT_SIZE_REM_DEFAULT;
  readonly uiFontSizeRemStep = UI_FONT_SIZE_REM_STEP;
  readonly selectedLocation = computed(() => {
    const modelId = this.selectedModelId();
    if (!modelId) {
      return null;
    }
    return findLlmModelLocation(this.llmProviders(), modelId);
  });
  readonly selectedProvider = computed(() => this.selectedLocation()?.provider ?? null);
  readonly selectedModel = computed(() => this.selectedLocation()?.model ?? null);
  /** Source existence, not whether edits to an existing source have been applied; see settingsDirty. */
  readonly tutorialSelectedSourceState = computed(() => {
    const ids = this.persistedSourceIds();
    if (!ids) return 'loading';
    const provider = this.selectedProvider();
    return provider ? (ids.has(provider.id) ? 'persisted' : 'draft') : 'none';
  });
  readonly selectedResolved = computed(() => {
    const loc = this.selectedLocation();
    if (!loc) {
      return null;
    }
    return mergeLlmProviderModel(loc.provider, loc.model);
  });
  /** True for the pinned remote llama-server row (URL + Connect), not managed run commands. */
  readonly isUrlOnlyLlamacpp = computed(() => {
    const p = this.selectedProvider();
    return p?.provider === 'openai-compatible';
  });
  /** Managed llama-server commands for the selected model (defaults when missing). */
  readonly selectedLlamaCppManaged = computed((): LlamaCppManaged => {
    const m = this.selectedModel();
    if (!m) {
      return defaultLlamaCppManaged();
    }
    return m.llamaCppManaged ?? defaultLlamaCppManaged();
  });
  readonly canDeleteSelectedProvider = computed(() => {
    const p = this.selectedProvider();
    if (!p || isPinnedLlmSourceId(p.id)) {
      return false;
    }
    return this.llmProviders().length > 1;
  });
  readonly settingsOverviewMeta = computed(() => {
    const parent = this.selectedSettingsTab();
    const subTabs = this.subTabsFor(parent);
    if (subTabs.length > 0) {
      const activeId = this.activeSubTabId(parent);
      const sub = subTabs.find((t) => t.id === activeId) ?? subTabs[0];
      const parentLabel = this.tabs.find((t) => t.id === parent)?.label ?? null;
      return { label: sub.label, description: sub.description, parentLabel };
    }
    const tab = this.tabs.find((t) => t.id === parent) ?? this.tabs[0];
    return { label: tab.label, description: tab.description, parentLabel: null as string | null };
  });
  /** Pinned sources first: LM Studio, remote llama URL, OpenRouter, Claude; then other sources, then local models, each in file order. */
  readonly sourcesOrdered = computed(() => {
    const list = this.llmProviders();
    const pinLm = list.find((p) => isPinnedLmStudioProviderId(p.id));
    const pinUrl = list.find((p) => isPinnedLlamaServerUrlProviderId(p.id));
    const pinOpenRouter = list.find((p) => isPinnedOpenRouterProviderId(p.id));
    const pinAnthropic = list.find((p) => isPinnedAnthropicProviderId(p.id));
    const rest = list.filter((p) => !isPinnedLlmSourceId(p.id));
    const head: LlmProviderConfig[] = [];
    if (pinLm) {
      head.push(pinLm);
    }
    if (pinUrl) {
      head.push(pinUrl);
    }
    if (pinOpenRouter) {
      head.push(pinOpenRouter);
    }
    if (pinAnthropic) {
      head.push(pinAnthropic);
    }
    return [
      ...head,
      ...rest.filter((p) => !this.isManagedLlamacppSource(p)),
      ...rest.filter((p) => this.isManagedLlamacppSource(p)),
    ];
  });
  /** Where local models start in {@link sourcesOrdered}, for the list's separator; -1 when there are none. */
  readonly firstLocalSourceIndex = computed(() =>
    this.sourcesOrdered().findIndex((p) => this.isManagedLlamacppSource(p)),
  );
  readonly lmStudioInventory = signal<LmStudioModelCard[]>([]);
  readonly lmStudioInventoryError = signal<string | null>(null);
  readonly lmStudioListInFlight = signal(false);
  private lmStudioListGen = 0;
  readonly openAiCompatModels = signal<OpenAiCompatModel[]>([]);
  readonly openAiCompatListError = signal<string | null>(null);
  readonly openAiCompatListInFlight = signal(false);
  readonly openAiCompatTestRunning = signal(false);
  readonly openAiCompatTestResult = signal<OpenAiCompatTestResult | null>(null);
  /** What the last test changed, in words, so the update isn't silent. */
  readonly openAiCompatApplied = signal<string[]>([]);
  private readonly openAiCompatTestedFor = signal('');
  /** Discards a slow reply that arrives after the user moved to another source. */
  private openAiCompatGen = 0;
  /** A slow listing of an old URL must not replace a newer one. */
  private openAiCompatListGen = 0;
  readonly openAiCompatSettings = computed(() => normalizeOpenAiCompatSettings(this.selectedModel()?.openAiCompat));
  /** The connection as typed, since a test runs before Apply. */
  private readonly openAiCompatEndpoint = computed((): OpenAiCompatEndpoint => {
    const p = this.selectedProvider();
    return {
      baseUrl: p?.baseUrl ?? '',
      apiKey: unwrapSecret(p?.apiKey),
      headers: (p?.customHeaders ?? []).map((h) => ({ key: h.key, value: unwrapSecret(h.value) })),
    };
  });
  /** True when the URL, key, headers or model changed after the last test. */
  readonly openAiCompatTestStale = computed(
    () =>
      !!this.openAiCompatTestResult() &&
      this.openAiCompatTestedFor() !== JSON.stringify([this.openAiCompatEndpoint(), this.selectedModel()?.model ?? '']),
  );
  /** Server that answered the last listing; null until one does. */
  readonly lmStudioConnection = signal<LmStudioConnection | null>(null);
  /** Model ids with a load or unload in flight. */
  readonly lmStudioBusyIds = signal<ReadonlySet<string>>(new Set());
  readonly lmStudioStatus = computed<LmStudioStatus>(() => {
    if (this.lmStudioListInFlight()) {
      return 'checking';
    }
    const connection = this.lmStudioConnection();
    if (connection) {
      return connection.baseUrl === this.selectedProvider()?.baseUrl ? 'connected' : 'stale';
    }
    return this.lmStudioInventoryError() ? 'offline' : 'idle';
  });
  readonly lmStudioSettings = computed(() => normalizeLmStudioSettings(this.selectedModel()?.lmStudio));
  /** True when the chat model runs with settings other than the ones saved here. */
  readonly lmStudioNeedsReload = computed(() => {
    const running = this.lmStudioChatCard()?.runningConfig;
    if (!running) {
      return false;
    }
    const maxContext = this.lmStudioChatCard()?.max_context_length ?? 0;
    return lmStudioRunningConfigDiffers(running, lmStudioLoadOptions(this.lmStudioSettings(), maxContext));
  });
  /** Inventory row for the selected chat model; null when this server does not list it. */
  readonly lmStudioChatCard = computed(() => {
    const id = this.selectedModel()?.model;
    return this.lmStudioInventory().find((c) => c.id === id) ?? null;
  });
  readonly lmStudioMainModelOptions = computed(() =>
    this.lmStudioInventory().filter((c) => !/embed/i.test(c.type)),
  );
  readonly lmStudioEmbeddingModelOptions = computed(() =>
    this.lmStudioInventory().filter((c) => /embed/i.test(c.type)),
  );
  readonly lmStudioLoadedCards = computed(() =>
    this.lmStudioInventory().filter((c) => c.state === 'loaded' || c.state === 'loading'),
  );
  readonly llamacppManagedModelIds = signal<string[]>([]);
  readonly openRouterModels = signal<OpenRouterCatalogModel[]>([]);
  readonly openRouterModelsListInFlight = signal(false);
  readonly openRouterModelsListError = signal<string | null>(null);
  /** ``GET /v1/models`` from embeddings base URL when it differs from chat (URL-only llama.cpp). */
  readonly llamacppUrlEmbeddingModelIds = signal<string[]>([]);
  readonly llamacppModelsListError = signal<string | null>(null);
  readonly llamacppModelsListInFlight = signal(false);
  /** Optional Hugging Face id (`org/repo` or `org/repo:quant`) for managed local without a local GGUF. */
  readonly managedHfIdDraft = signal('');
  /**
   * What the Local model picker offers: a separate head or a vision projector can't load as a main model. A hub row's file name
   * is its folder, which says nothing about that.
   */
  readonly managedInventoryModels = computed(() =>
    this.modelManagerCustomModels().filter((m) => {
      const name = m.fileName || m.absolutePath;
      return (
        m.entryKind === 'hubRepo' ||
        !(isMtpCompanionGgufFileName(name) || isDraftSidecarGgufFileName(name) || isMmprojGgufFileName(name))
      );
    }),
  );
  /** Select value for the managed model picker (`gguf:…` / `hub:…` / `hf:…` / empty). */
  readonly managedPickerValue = computed(() =>
    managedPickerValueForCmd(this.selectedLlamaCppManaged().chatRunCommand, this.modelManagerCustomModels()),
  );
  /** Picker inventory availability; an error or unfinished scan is not an empty inventory. */
  readonly tutorialLocalModelsState = computed(() => {
    if (this.localInventoryInflight() > 0 || this.modelManagerLocalLoading()) return 'loading';
    const result = this.localInventoryResult();
    if (result === 'unknown' || result === 'error') return result;
    // An HF command (including the new-source placeholder) is not a downloaded local model.
    return this.managedInventoryModels().length > 0 ? 'ready' : 'empty';
  });
  readonly tutorialLocalModelSelected = computed(() =>
    this.managedInventoryModels().some((model) => this.managedInventoryOptionValue(model) === this.managedPickerValue()),
  );
  /** NVIDIA cards in CUDA index order (empty until NVML inventory returns). */
  readonly cudaGpus = signal<CudaGpuDevice[]>([]);
  readonly managedGpuOffloadMode = computed((): ManagedGpuOffloadMode =>
    parseManagedLlamaGpuOffload(this.selectedLlamaCppManaged().chatRunCommand).mode,
  );
  /** Path of the GGUF the chat command loads, when it names a local file. */
  readonly managedGgufPath = computed((): string | null => {
    const sel = parseManagedLlamaModelSelection(this.selectedLlamaCppManaged().chatRunCommand);
    return sel?.kind === 'gguf' ? sel.absolutePath : null;
  });
  /** What each card has allocated now, counting what `nvidia-smi` leaves out. */
  readonly managedVramUsage = signal<readonly GpuVramCardUsage[]>([]);
  /** On-disk size read from main. A hub repo's inventory size covers its whole folder, not this file. */
  readonly managedGgufFileSize = signal<{ path: string; bytes: number } | null>(null);
  readonly managedGgufSizeBytes = computed((): number | null => {
    const path = this.managedGgufPath();
    if (!path) {
      return null;
    }
    const stat = this.managedGgufFileSize();
    if (stat?.path === path) {
      return stat.bytes;
    }
    const hit = this.modelManagerCustomModels().find((m) => m.absolutePath === path);
    return hit && Number.isFinite(hit.sizeBytes) ? hit.sizeBytes : null;
  });
  /** GGUF headers read from main, by path. */
  readonly managedGgufProfiles = signal<Readonly<Record<string, GgufProfile>>>({});
  readonly managedGgufProfile = computed((): GgufProfile | null =>
    this.managedGgufProfileAt(this.managedGgufPath()),
  );
  /** A separate MTP head that goes with the GGUF the chat command loads. */
  readonly managedMtpCompanionPath = computed((): string | null => {
    const path = this.managedGgufPath();
    return path ? resolveMtpPathForManagedGguf(path, this.modelManagerCustomModels()) : null;
  });
  /** The MTP head the selected model can run on, once the headers have been read. */
  readonly managedMtpHead = computed(() => {
    const profile = this.managedGgufProfile();
    const companionPath = this.managedMtpCompanionPath();
    return profile ? managedMtpHead(profile, companionPath, this.managedGgufProfileAt(companionPath)) : null;
  });
  /** The local draft model the chat command names. */
  readonly managedDraftModelPath = computed((): string | null =>
    readLlamaFlagValue(this.selectedLlamaCppManaged().chatRunCommand, LOCAL_DRAFT_MODEL_FLAG_NAMES),
  );
  readonly managedDraftModelBytes = computed(
    (): number | undefined => this.managedGgufProfileAt(this.managedDraftModelPath())?.tensorBytes,
  );
  readonly managedGpuAdvice = computed(() => {
    const cmd = this.selectedLlamaCppManaged().chatRunCommand;
    const profile = this.managedGgufProfile();
    return recommendGpuOffload(
      this.cudaGpus(),
      this.managedGgufSizeBytes(),
      parseManagedLlamaContextSize(cmd) ?? 0,
      this.managedVramUsage(),
      managedLlamaKvCacheWeight(cmd),
      profile ? { profile, command: cmd, companionHeadBytes: this.managedDraftModelBytes() } : null,
    );
  });
  readonly managedGpuSplitRatioLabel = computed(() => {
    const gpus = this.cudaGpus();
    if (gpus.length < 2) {
      return '';
    }
    return gpus.map((g) => formatGpuVramGb(g.memoryTotalMb)).join(' : ');
  });

  readonly managedSelectedFamilyLabel = computed(() => {
    const sel = parseManagedLlamaModelSelection(this.selectedLlamaCppManaged().chatRunCommand);
    const hint =
      sel?.kind === 'gguf'
        ? sel.absolutePath
        : sel?.kind === 'hf'
          ? sel.hfId
          : this.managedHfIdDraft();
    const family = inferModelFamilyFromHint(hint);
    if (family === 'qwen') {
      return 'Qwen';
    }
    if (family === 'gemma') {
      return 'Gemma';
    }
    return 'Other';
  });
  readonly readyDefaultsSummary = computed(() => {
    const c = this.selectedResolved();
    if (!c) {
      return '';
    }
    return (
      optimizationPresetsForProvider(c.provider).find((p) => p.id === c.optimizationPreset)?.summary ?? ''
    );
  });
  readonly llamacppUrlModelsSummary = computed(() => {
    const chat = this.llamacppManagedModelIds().length;
    const emb = this.llamacppUrlEmbeddingModelIds().length;
    const p = this.selectedProvider();
    if (!p || p.provider !== 'llamacpp') {
      return `${chat} models`;
    }
    const embUrl = (p.embeddingsBaseUrl ?? '').trim();
    if (!embUrl || openAiV1BasesEquivalent(p.baseUrl, embUrl)) {
      return `${chat} models`;
    }
    return `${chat} chat · ${emb} embedding`;
  });

  private subscription: Subscription | null = null;
  private settingsSelectTabSubscription: Subscription | null = null;
  private hfDownloadSubscription: Subscription | null = null;
  private configSnapshot: AppConfig | null = null;
  /** Moves with every change, so a save can tell whether anything changed while it ran. */
  private dirtyRevision = 0;
  /**
   * True once the user toggled "Confirm before moving files and folders" in this window. While
   * false, a `config-updated` broadcast (e.g. the dialog's "Don't ask again") wins, so a later
   * Apply cannot write a stale value back over it.
   */
  private confirmMoveTouched = false;

  constructor(
    private electron: ElectronService,
    private themedConfirm: ThemedConfirmDialogService,
    private themedPrompt: ThemedPromptDialogService,
  ) {
    effect(() => {
      const saving = this.settingsSaving();
      untracked(() => this.scheduleSaveSpinnerSync(saving));
    });
    effect(() => {
      const loading = this.modelManagerLocalLoading();
      untracked(() => this.scheduleNamedSpinnerSync(this.localModelsSpinnerName, loading));
      untracked(() => this.scheduleNamedSpinnerSync(this.localModelDropdownSpinnerName, loading));
    });
    effect(() => {
      const loading = this.modelManagerHfBusy();
      untracked(() => this.scheduleNamedSpinnerSync(this.hfSearchSpinnerName, loading));
    });
    effect(() => {
      const loading = this.whisperModelsLoading();
      untracked(() => this.scheduleNamedSpinnerSync(this.whisperModelDropdownSpinnerName, loading));
    });
    this.themes$.attach({
      themeId: this.themeId,
      markDirty: () => this.markSettingsDirty(),
    });
    // Library arrives asynchronously from main and `themeId` re-hydrates from config;
    // re-derive the editing draft whenever either changes.
    effect(() => {
      this.themeEngine.library();
      this.themeId();
      untracked(() => this.themes$.syncSelectionFromHost());
    });
  }

  async ngOnInit(): Promise<void> {
    this.settingsSelectTabSubscription = this.electron.settingsSelectTab$.subscribe((tab) => {
      if (isSettingsTab(tab)) {
        this.selectTab(tab);
      }
    });
    this.electron.notifySettingsWindowReady();

    const config = await this.electron.loadConfig();
    this.configSnapshot = structuredClone(config);
    this.syncFromConfig(config, true);

    this.subscription = this.electron.config$.subscribe((nextConfig: AppConfig) => {
      if (this.settingsSaveAction() !== null) {
        return;
      }
      this.syncFromConfig(nextConfig, false);
    });

    void this.electron.listSystemFonts().then((fonts: SystemFontInfo[]) => this.systemFonts.set(fonts));
    void this.electron.listCudaGpus().then((gpus) => this.cudaGpus.set(gpus));

    this.hfDownloadSubscription = this.electron.hfDownloadProgress$.subscribe((e: HfDownloadProgressEvent) => {
      const id = e.downloadId;
      if (e.phase === 'queued') {
        this.modelManagerHfDownloads.update((m) => ({
          ...m,
          [id]: { repoId: e.repoId, fileName: e.fileName, receivedBytes: 0, totalBytes: null },
        }));
      } else if (e.phase === 'progress') {
        this.modelManagerHfDownloads.update((m) => {
          const cur = m[id];
          if (!cur) return m;
          return { ...m, [id]: { ...cur, receivedBytes: e.receivedBytes, totalBytes: e.totalBytes } };
        });
      } else if (e.phase === 'done') {
        this.modelManagerHfDownloads.update((m) => {
          const next = { ...m };
          delete next[id];
          return next;
        });
        if (e.absolutePath) {
          this.modelManagerHfDownloaded.update((m) => ({ ...m, [id]: e.absolutePath as string }));
        }
        void this.refreshCustomModelCards();
      } else if (e.phase === 'error' || e.phase === 'cancelled') {
        this.modelManagerHfDownloads.update((m) => {
          const next = { ...m };
          delete next[id];
          return next;
        });
      }
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    void this.ngxSpinner.hide(this.settingsSaveSpinnerName);
    void this.ngxSpinner.hide(this.localModelsSpinnerName);
    void this.ngxSpinner.hide(this.localModelDropdownSpinnerName);
    void this.ngxSpinner.hide(this.hfSearchSpinnerName);
    void this.ngxSpinner.hide(this.whisperModelDropdownSpinnerName);
    this.subscription?.unsubscribe();
    this.settingsSelectTabSubscription?.unsubscribe();
    this.hfDownloadSubscription?.unsubscribe();
    // Only Apply persists; closing the window discards unapplied edits and drops the live preview.
    this.themes$.cancelPreview();
  }

  selectSettingsSubTab(tab: SettingsTab, id: string): void {
    this.selectTab(tab);
    this.selectedSubTabs.update((prev) => ({ ...prev, [tab]: id }));
  }

  subTabsFor(tab: SettingsTab): SettingsSubTabEntry[] {
    return this.settingsSubTabCatalog[tab] ?? [];
  }

  activeSubTabId(tab: SettingsTab): string {
    const entries = this.subTabsFor(tab);
    if (entries.length === 0) {
      return '';
    }
    const saved = this.selectedSubTabs()[tab];
    if (saved && entries.some((e) => e.id === saved)) {
      return saved;
    }
    return entries[0].id;
  }

  settingsSubTabSummary(tab: SettingsTab, id: string): string {
    switch (tab) {
      case 'themes': {
        const theme = this.themes$.selectedTheme();
        if (id === 'library') {
          return `${this.themes.length} themes`;
        }
        if (id === 'global') {
          return `${Object.keys(theme.tokens).length} tokens`;
        }
        if (id === 'monaco') {
          return theme.monaco ? 'Custom' : 'Derived';
        }
        if (id === 'advanced') {
          const warnings = this.themes$.validation().warnings.length;
          return warnings > 0 ? `${warnings} warning${warnings === 1 ? '' : 's'}` : 'Valid';
        }
        const category = themesCategoryFromSubTabId(id);
        if (category) {
          const count = this.themes$.groups.filter((g) => g.category === category && theme.groups[g.id]).length;
          return count > 0 ? `${count} customized` : 'Inherits';
        }
        break;
      }
      case 'general':
        if (id === 'chat') {
          const sizeLabel =
            CHAT_CONTAINER_SIZE_OPTIONS.find((opt) => opt.value === this.chatContainerSize())?.label ?? 'Standard';
          return `${sizeLabel} · UI ${this.uiFontSizeRem()} · chat ${this.chatFontSizeRem()}rem`;
        }
        if (id === 'behavior') {
          return this.confirmMove() ? 'Confirm moves' : 'No move prompt';
        }
        break;
      case 'tools':
        if (id === 'editTools') {
          return this.editToolsMode() === 'strict' ? 'Strict' : 'Standard';
        }
        if (id === 'limits') {
          return `${this.maxFileReadLines()} · ${this.maxSearchResults()}`;
        }
        if (id === 'compression') {
          return this.contextCompressionEnabled() ? 'On' : 'Off';
        }
        if (id === 'encoding') {
          return this.defaultWorkspaceEncoding();
        }
        if (id === 'webTools') {
          return `${this.screenshotRetention().retentionDays}d`;
        }
        break;
      case 'monaco':
        return this.monacoSubTabSummary(id);
      case 'audio': {
        if (id === 'provider') {
          const p = this.audioProvider();
          if (p === 'disabled') return 'Disabled';
          if (p === 'whisper') return 'Whisper';
          return 'OpenAI';
        }
        if (id === 'endpoint') {
          const url = this.audioBaseUrl().trim();
          if (!url) return '—';
          try {
            return new URL(url).host;
          } catch {
            return url.length > 12 ? `${url.slice(0, 12)}…` : url;
          }
        }
        if (id === 'capture') {
          return `${this.talkSilenceThresholdSeconds()}s`;
        }
        if (id === 'tts') {
          if (this.ttsProvider() === 'openai-compatible') {
            return `Remote • ${this.ttsVoice()}`;
          }
          return `${this.ttsSpeechSpeed()}×`;
        }
        break;
      }
      default:
        break;
    }
    return '';
  }

  selectTab(tab: SettingsTab): void {
    this.selectedSettingsTab.set(tab);
    if (tab === 'audio') {
      void this.refreshTalkAudioInputs();
      void this.refreshWhisperDownloadedModels();
      // Audio pane mounts after this tab switch; re-show so ngx-spinner is in the DOM.
      this.scheduleNamedSpinnerSync(this.whisperModelDropdownSpinnerName, this.whisperModelsLoading());
    } else if (tab === 'modelManager') {
      void this.refreshModelManagerData();
    } else if (tab === 'models') {
      void this.refreshCustomModelCards();
    }
  }

  /** Double-clicking the top bar toggles maximize, matching the main window's title bar. */
  onTopBarDoubleClick(): void {
    this.electron.windowToggleMaximize();
  }

  /** Persist dirty settings without closing the window. */
  async applySettings(): Promise<void> {
    if (this.settingsSaveAction() !== null || !this.settingsDirty()) {
      return;
    }
    this.settingsSaveAction.set('apply');
    try {
      await this.flushPersistIfDirty();
    } finally {
      this.settingsSaveAction.set(null);
    }
  }

  /** Close from the top-bar exit button; unapplied edits are discarded after a confirmation. */
  async closeSettings(): Promise<void> {
    if (this.settingsSaveAction() !== null) {
      return;
    }
    if (this.settingsDirty()) {
      const proceed = (await this.themedConfirm.open(discardSettingsChangesPrompt())) === 'confirm';
      if (!proceed) {
        return;
      }
      this.settingsDirty.set(false);
    }
    this.themes$.cancelPreview();
    this.electron.closeSettingsWindow();
  }

  /** Close the settings window once changes are applied; OK stays disabled while edits are pending. */
  async okSettings(): Promise<void> {
    if (this.settingsSaveAction() !== null || this.settingsDirty()) {
      return;
    }
    this.settingsSaveAction.set('ok');
    try {
      await this.flushPersistIfDirty();
    } finally {
      this.settingsSaveAction.set(null);
      this.electron.closeSettingsWindow();
    }
  }

  private scheduleSaveSpinnerSync(show: boolean): void {
    afterNextRender(
      () => {
        if (this.destroyed) {
          return;
        }
        if (show) {
          void this.ngxSpinner.show(this.settingsSaveSpinnerName, CLOSE_SAVE_SPINNER);
        } else {
          void this.ngxSpinner.hide(this.settingsSaveSpinnerName);
        }
      },
      { injector: this.inj },
    );
  }

  private scheduleNamedSpinnerSync(name: string, show: boolean): void {
    afterNextRender(
      () => {
        if (this.destroyed) {
          return;
        }
        if (show) {
          void this.ngxSpinner.show(name, CACHE_DETECT_SPINNER);
        } else {
          void this.ngxSpinner.hide(name);
        }
      },
      { injector: this.inj },
    );
  }

  private async flushPersistIfDirty(): Promise<void> {
    if (!this.configSnapshot || !this.settingsDirty()) {
      return;
    }
    await this.enqueuePersist();
  }

  onThemeChange(themeId: string): void {
    this.themeId.set(themeId);
    this.markSettingsDirty();
  }

  /** Pick a folder and register it; returns the new (or already-registered) workspace id. */
  async addWorkspace(): Promise<string | null> {
    const selected = await this.electron.openDirectoryDialog();
    if (!selected) {
      return null;
    }

    const existing = this.workspaces().find((workspace) => workspace.path === selected);
    if (existing) {
      return existing.id;
    }

    const name = selected.split(/[\\/]/).pop() || 'New Workspace';
    const added = await this.electron.addWorkspace(name, selected);
    return added?.id ?? null;
  }

  /** Confirm, then drop the workspace and its app data (chats, index). The folder on disk is untouched. */
  async removeWorkspace(id: string): Promise<boolean> {
    const workspace = this.workspaces().find((w) => w.id === id);
    if (!workspace) {
      return false;
    }
    const proceed = (await this.themedConfirm.open(workspaceRemovePrompt(workspace.name))) === 'confirm';
    if (!proceed) {
      return false;
    }
    await this.electron.removeWorkspace(id);
    return true;
  }

  async toggleWorkspaceFavorite(id: string): Promise<void> {
    const current = this.workspaces().find((workspace) => workspace.id === id);
    if (!current) {
      return;
    }
    const nextFavorite = !current.favorite;
    const saved = await this.electron.setWorkspaceFavorite(id, nextFavorite);
    this.workspaces.set(saved?.workspaces ?? setWorkspaceFavorite(this.workspaces(), id, nextFavorite));
  }

  async selectWorkspace(id: string): Promise<void> {
    const config = await this.electron.loadConfig();
    const fromWorkspaceId = config.currentWorkspaceId;

    const unsaved = await this.electron.getWorkspaceMonacoUnsavedPaths();
    if (unsaved.length > 0) {
      const proceed = (await this.themedConfirm.open(unsavedWorkspaceSwitchPrompt(unsaved))) === 'confirm';
      if (!proceed) {
        return;
      }
    }

    const pending = await this.electron.getPendingStreamIdsForWorkspace(fromWorkspaceId);
    if (pending.length > 0) {
      const proceed = (await this.themedConfirm.open(activeStreamWorkspaceSwitchPrompt(pending.length))) === 'confirm';
      if (!proceed) {
        return;
      }
      await this.electron.abortPendingStreamsForWorkspace(fromWorkspaceId);
    }

    await this.electron.setCurrentWorkspace(id);
  }

  selectSource(providerId: string): void {
    const p = this.llmProviders().find((x) => x.id === providerId);
    const first = p?.models[0];
    if (!first) {
      return;
    }
    this.selectedModelId.set(first.id);
    if (p.provider === 'lmstudio') {
      void this.refreshLmStudioInventory();
    } else {
      this.clearLmStudioInventory();
    }
    this.clearOpenAiCompatState();
    if (p.provider === 'openai-compatible') {
      void this.refreshOpenAiCompatModels();
    }
    if (p.provider === 'llamacpp') {
      this.llamacppUrlEmbeddingModelIds.set([]);
      void this.refreshCustomModelCards();
      void this.refreshLlamacppManagedModels();
      const cmd = p.models[0]?.llamaCppManaged?.chatRunCommand ?? '';
      const sel = parseManagedLlamaModelSelection(cmd);
      this.managedHfIdDraft.set(sel?.kind === 'hf' ? sel.hfId : '');
    } else {
      this.llamacppManagedModelIds.set([]);
      this.llamacppUrlEmbeddingModelIds.set([]);
      this.llamacppModelsListError.set(null);
    }
    if (p.provider !== 'openrouter') {
      this.openRouterModels.set([]);
      this.openRouterModelsListError.set(null);
    }
  }

  activateSource(providerId: string): void {
    const p = this.llmProviders().find((x) => x.id === providerId);
    const first = p?.models[0];
    if (!first) {
      return;
    }
    if (this.activeLlmModelId() === first.id) {
      return;
    }
    this.activeLlmModelId.set(first.id);
    this.markSettingsDirty();
  }

  sourceIsSelected(provider: LlmProviderConfig): boolean {
    return this.selectedProvider()?.id === provider.id;
  }

  /** Whether this row exists on disk, independent of any unapplied field edits. */
  sourcePersistenceState(provider: LlmProviderConfig): 'loading' | 'draft' | 'persisted' {
    const ids = this.persistedSourceIds();
    return !ids ? 'loading' : ids.has(provider.id) ? 'persisted' : 'draft';
  }

  async refreshLlamacppManagedModels(): Promise<void> {
    const p = this.selectedProvider();
    const m = this.selectedModel();
    if (!p || p.provider !== 'llamacpp' || !m) {
      return;
    }
    if (!((m.llamaCppManaged?.chatRunCommand ?? '').trim())) {
      return;
    }
    this.llamacppModelsListInFlight.set(true);
    this.llamacppModelsListError.set(null);
    try {
      const cfg = this.buildConfigForPersist();
      const res = await this.electron.llamacppManagedListModels({ modelId: m.id, config: cfg });
      if (res.ok) {
        this.llamacppManagedModelIds.set(res.models);
        this.llamacppUrlEmbeddingModelIds.set([]);
      } else {
        this.llamacppManagedModelIds.set([]);
        this.llamacppUrlEmbeddingModelIds.set([]);
        this.llamacppModelsListError.set(res.error);
      }
    } catch (e) {
      this.llamacppManagedModelIds.set([]);
      this.llamacppUrlEmbeddingModelIds.set([]);
      this.llamacppModelsListError.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.llamacppModelsListInFlight.set(false);
    }
  }

  async refreshOpenRouterModels(): Promise<void> {
    const p = this.selectedProvider();
    if (!p || p.provider !== 'openrouter') {
      return;
    }
    this.openRouterModelsListInFlight.set(true);
    this.openRouterModelsListError.set(null);
    try {
      const res = await this.electron.openRouterListModels({
        baseUrl: p.baseUrl,
        apiKey: unwrapSecret(p.apiKey) || '',
      });
      if (!res.ok) {
        this.openRouterModels.set([]);
        this.openRouterModelsListError.set(res.error);
        return;
      }
      this.openRouterModels.set(res.models);
    } catch (e) {
      this.openRouterModels.set([]);
      this.openRouterModelsListError.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.openRouterModelsListInFlight.set(false);
    }
  }

  onOpenRouterModelChange(model: string): void {
    const loc = this.selectedLocation();
    if (!loc) {
      return;
    }
    const hit = this.openRouterModels().find((row) => row.id === model);
    const contextWindowTokens =
      hit && hit.contextLength > 0 ? hit.contextLength : inferContextWindowTokens(model, 'openrouter');
    this.applyLlmModelPatch(loc.model.id, {
      model,
      name: hit?.name || model,
      contextWindowTokens,
    });
    this.markSettingsDirty();
  }

  /**
   * Commit the API key and base URL drafted on the OpenRouter card. Unlike the other source fields
   * these are only written on Save, which persists right away and then reloads the catalog.
   */
  async saveOpenRouterConnection(changes: { apiKey: string; baseUrl: string }): Promise<void> {
    const p = this.selectedProvider();
    if (!p || p.provider !== 'openrouter') {
      return;
    }
    this.applyProviderPatch(p.id, {
      apiKey: SecretValue.of(changes.apiKey.trim()),
      baseUrl: changes.baseUrl.trim() || OPENROUTER_DEFAULT_BASE_URL,
    });
    this.markSettingsDirty();
    await this.applySettings();
    await this.refreshOpenRouterModels();
  }

  /**
   * Mirror a Claude model pick into the draft. Main already saved it (``anthropic:set-model``), so
   * this does not mark Settings dirty; it only keeps this window's view current while dirty.
   */
  mirrorClaudeModel(model: AnthropicCatalogModel): void {
    const profile = this.llmProviders().find((p) => p.provider === 'anthropic')?.models[0];
    if (!profile) {
      return;
    }
    this.applyLlmModelPatch(profile.id, {
      model: model.id,
      name: model.displayName,
      contextWindowTokens: model.maxInputTokens || inferContextWindowTokens(model.id, 'anthropic'),
    });
  }

  isPinnedSource(providerId: string): boolean {
    return isPinnedLlmSourceId(providerId);
  }

  private clearLmStudioInventory(): void {
    this.lmStudioListGen += 1;
    this.lmStudioListInFlight.set(false);
    this.lmStudioInventory.set([]);
    this.lmStudioInventoryError.set(null);
    this.lmStudioConnection.set(null);
  }

  async refreshLmStudioInventory(): Promise<void> {
    const p = this.selectedProvider();
    if (!p || p.provider !== 'lmstudio') {
      return;
    }
    const gen = ++this.lmStudioListGen;
    const providerId = p.id;
    this.lmStudioListInFlight.set(true);
    this.lmStudioInventoryError.set(null);
    try {
      const res = await this.electron.lmStudioListModels({ baseUrl: p.baseUrl, apiKey: unwrapSecret(p.apiKey) });
      if (gen !== this.lmStudioListGen) {
        return;
      }
      const still = this.selectedProvider();
      if (!still || still.id !== providerId || still.provider !== 'lmstudio') {
        return;
      }
      if (res.ok) {
        this.lmStudioInventory.set(res.models);
        this.lmStudioConnection.set({ baseUrl: p.baseUrl, origin: res.origin, source: res.source });
        this.applyLmStudioLiveContextFromInventory();
      } else {
        this.lmStudioInventory.set([]);
        this.lmStudioConnection.set(null);
        this.lmStudioInventoryError.set(res.error);
      }
    } catch (e) {
      if (gen !== this.lmStudioListGen) {
        return;
      }
      this.lmStudioInventory.set([]);
      this.lmStudioConnection.set(null);
      this.lmStudioInventoryError.set(e instanceof Error ? e.message : String(e));
    } finally {
      if (gen === this.lmStudioListGen) {
        this.lmStudioListInFlight.set(false);
      }
    }
  }

  private applyLmStudioLiveContextFromInventory(): void {
    const loc = this.selectedLocation();
    if (!loc || loc.provider.provider !== 'lmstudio') {
      return;
    }
    const inv = this.lmStudioInventory();
    for (const m of loc.provider.models) {
      const card = inv.find((c) => c.id === m.model);
      const n = card ? effectiveLmStudioContextTokens(card) : 0;
      this.electron.applyLiveContextWindow(m.id, n > 0 ? n : undefined);
    }
  }

  updateOpenAiCompatSettings(changes: Partial<OpenAiCompatSettings>): void {
    this.updateSelectedModel({ openAiCompat: { ...this.openAiCompatSettings(), ...changes } });
  }

  private clearOpenAiCompatState(): void {
    this.openAiCompatGen += 1;
    this.openAiCompatModels.set([]);
    this.openAiCompatListError.set(null);
    this.openAiCompatListInFlight.set(false);
    this.openAiCompatTestRunning.set(false);
    this.openAiCompatTestResult.set(null);
    this.openAiCompatApplied.set([]);
  }

  async refreshOpenAiCompatModels(): Promise<void> {
    if (this.selectedProvider()?.provider !== 'openai-compatible') {
      return;
    }
    const gen = this.openAiCompatGen;
    const list = ++this.openAiCompatListGen;
    const current = () => gen === this.openAiCompatGen && list === this.openAiCompatListGen;
    this.openAiCompatListInFlight.set(true);
    this.openAiCompatListError.set(null);
    try {
      const res = await this.electron.openAiCompatListModels(this.openAiCompatEndpoint());
      if (!current()) {
        return;
      }
      this.openAiCompatModels.set(res.ok ? res.models : []);
      this.openAiCompatListError.set(res.ok ? null : res.error);
    } catch (e) {
      if (current()) {
        this.openAiCompatModels.set([]);
        this.openAiCompatListError.set(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (current()) {
        this.openAiCompatListInFlight.set(false);
      }
    }
  }

  /** Test the connection as typed, then set Compatibility to what the server turned out to accept. */
  async runOpenAiCompatConnectionTest(): Promise<void> {
    if (this.selectedProvider()?.provider !== 'openai-compatible' || this.openAiCompatTestRunning()) {
      return;
    }
    const gen = this.openAiCompatGen;
    const endpoint = this.openAiCompatEndpoint();
    const model = this.selectedModel()?.model ?? '';
    this.openAiCompatTestRunning.set(true);
    this.openAiCompatApplied.set([]);
    try {
      const result = await this.electron.openAiCompatTest(endpoint, model);
      if (gen !== this.openAiCompatGen || !result) {
        return;
      }
      this.openAiCompatTestResult.set(result);
      this.openAiCompatTestedFor.set(JSON.stringify([endpoint, model]));
      this.applyOpenAiCompatSuggestions(result);
      void this.refreshOpenAiCompatModels();
    } finally {
      if (gen === this.openAiCompatGen) {
        this.openAiCompatTestRunning.set(false);
      }
    }
  }

  private applyOpenAiCompatSuggestions(result: OpenAiCompatTestResult): void {
    const current = this.openAiCompatSettings();
    const changed = (Object.keys(result.suggestions) as (keyof OpenAiCompatTestResult['suggestions'])[]).filter(
      (key) => result.suggestions[key] !== current[key],
    );
    if (!changed.length) {
      return;
    }
    const describe: Record<(typeof changed)[number], () => string> = {
      tokensField: () => `output tokens field is ${result.suggestions.tokensField}`,
      thinkingMethod: () => `thinking control is ${result.suggestions.thinkingMethod === 'none' ? 'off' : result.suggestions.thinkingMethod}`,
      sendTemperature: () => `temperature ${result.suggestions.sendTemperature ? 'sent' : 'not sent'}`,
      sendParallelToolCalls: () => `parallel_tool_calls ${result.suggestions.sendParallelToolCalls ? 'sent' : 'not sent'}`,
      streamUsage: () => `token usage ${result.suggestions.streamUsage ? 'requested' : 'not requested'}`,
    };
    this.updateOpenAiCompatSettings(result.suggestions);
    this.openAiCompatApplied.set(changed.map((key) => describe[key]()));
  }

  lmStudioModelBusy(id: string): boolean {
    return this.lmStudioBusyIds().has(id);
  }

  private setLmStudioBusy(id: string, busy: boolean): void {
    this.lmStudioBusyIds.update((ids) => {
      const next = new Set(ids);
      if (busy) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  updateLmStudioSettings(changes: Partial<LmStudioSettings>): void {
    this.updateSelectedModel({ lmStudio: { ...this.lmStudioSettings(), ...changes } });
  }

  /** Load one model with the saved settings. */
  async loadLmStudioModel(id: string): Promise<void> {
    const p = this.selectedProvider();
    if (!p || p.provider !== 'lmstudio' || !id || this.lmStudioModelBusy(id)) {
      return;
    }
    const maxContext = this.lmStudioInventory().find((c) => c.id === id)?.max_context_length ?? 0;
    this.setLmStudioBusy(id, true);
    try {
      const r = await this.electron.lmStudioLoadModel({
        baseUrl: p.baseUrl,
        model: id,
        apiKey: unwrapSecret(p.apiKey),
        options: lmStudioLoadOptions(this.lmStudioSettings(), maxContext),
      });
      await this.refreshLmStudioInventory();
      if (!r.ok) {
        this.lmStudioInventoryError.set(`${id}: ${r.error}`);
      }
    } finally {
      this.setLmStudioBusy(id, false);
    }
  }

  /** Apply changed load settings to the running chat model. */
  async reloadLmStudioChatModel(): Promise<void> {
    const card = this.lmStudioChatCard();
    if (!card) {
      return;
    }
    await this.unloadLmStudioCard(card);
    if (!this.lmStudioInventoryError()) {
      await this.loadLmStudioModel(card.id);
    }
  }

  async unloadLmStudioCard(card: LmStudioModelCard): Promise<void> {
    const p = this.selectedProvider();
    if (!p || p.provider !== 'lmstudio' || !card.instanceId || this.lmStudioModelBusy(card.id)) {
      return;
    }
    this.setLmStudioBusy(card.id, true);
    try {
      const r = await this.electron.lmStudioUnloadModel({
        baseUrl: p.baseUrl,
        instanceId: card.instanceId,
        apiKey: unwrapSecret(p.apiKey),
      });
      await this.refreshLmStudioInventory();
      if (!r.ok) {
        this.lmStudioInventoryError.set(r.error);
      }
    } finally {
      this.setLmStudioBusy(card.id, false);
    }
  }

  addProvider(): void {
    const nextProvider = this.buildNewLlamacppProvider();
    this.llmProviders.update((p) => [...p, nextProvider]);
    const firstId = nextProvider.models[0]?.id ?? null;
    this.selectedModelId.set(firstId);
    if (nextProvider.provider === 'llamacpp' && firstId) {
      void this.refreshLlamacppManagedModels();
    }
    this.markSettingsDirty();
  }

  /** A source row's remove button: a local model source asks first. */
  async requestRemoveProvider(provider: LlmProviderConfig): Promise<void> {
    if (this.isManagedLlamacppSource(provider)) {
      const prompt = localSourceRemovePrompt(this.sourceDisplayName(provider));
      if ((await this.themedConfirm.open(prompt)) !== 'confirm') {
        return;
      }
    }
    this.removeProvider(provider.id);
  }

  removeProvider(providerId: string): void {
    if (isPinnedLlmSourceId(providerId)) {
      return;
    }
    if (this.llmProviders().length <= 1) {
      return;
    }
    const removed = this.llmProviders().find((p) => p.id === providerId);
    const removedModelIds = new Set(removed?.models.map((m) => m.id) ?? []);
    const nextProviders = this.llmProviders().filter((p) => p.id !== providerId);
    let nextActive = this.activeLlmModelId();
    if (removedModelIds.has(nextActive)) {
      nextActive = nextProviders[0]?.models[0]?.id ?? nextActive;
    }
    this.llmProviders.set(nextProviders);
    this.activeLlmModelId.set(nextActive);
    this.selectedModelId.set(nextActive);
    this.markSettingsDirty();
  }

  removeSelectedProvider(): void {
    const p = this.selectedProvider();
    if (!p) {
      return;
    }
    this.removeProvider(p.id);
  }

  removeModel(providerId: string, modelId: string): void {
    if (countLlmModels(this.llmProviders()) <= 1) {
      return;
    }
    const provider = this.llmProviders().find((p) => p.id === providerId);
    if (!provider) {
      return;
    }
    if (provider.models.length === 1) {
      this.removeProvider(providerId);
      return;
    }
    const providerNow = this.llmProviders().find((p) => p.id === providerId);
    if (!providerNow) {
      return;
    }
    const nextModels = providerNow.models.filter((m) => m.id !== modelId);
    let nextActive = this.activeLlmModelId();
    if (nextActive === modelId) {
      nextActive = nextModels[0]?.id ?? nextActive;
    }
    this.llmProviders.update((providers) =>
      providers.map((p) => (p.id === providerId ? { ...p, models: nextModels } : p)),
    );
    this.activeLlmModelId.set(nextActive);
    this.selectedModelId.set(nextActive);
    this.markSettingsDirty();
  }

  updateSelectedModel(changes: Partial<LlmModelProfile>): void {
    const modelId = this.selectedModelId();
    if (!modelId) {
      return;
    }
    if (!findLlmModelLocation(this.llmProviders(), modelId)) {
      return;
    }
    this.applyLlmModelPatch(modelId, changes);
    this.markSettingsDirty();
  }

  updateSelectedProvider(
    changes: Partial<
      Pick<
        LlmProviderConfig,
        'name' | 'customName' | 'provider' | 'baseUrl' | 'apiKey' | 'embeddingsModel' | 'embeddingsBaseUrl' | 'customHeaders'
      >
    >,
  ): void {
    const loc = this.selectedLocation();
    if (!loc) {
      return;
    }
    this.applyProviderPatch(loc.provider.id, changes);
    this.markSettingsDirty();
  }

  onProviderKindChange(provider: LlmProviderConfig['provider']): void {
    const loc = this.selectedLocation();
    if (!loc) {
      return;
    }
    if (isPinnedLlmSourceId(loc.provider.id)) {
      return;
    }
    const defaults = this.getProviderDefaults(provider);
    this.applyProviderPatch(loc.provider.id, {
      provider,
      baseUrl: defaults.baseUrl,
      apiKey: defaults.apiKey,
    });
    this.markSettingsDirty();
  }

  onModelApiIdChange(model: string): void {
    const loc = this.selectedLocation();
    if (!loc) {
      return;
    }
    let contextWindowTokens = inferContextWindowTokens(model, loc.provider.provider);
    let name = model;
    if (loc.provider.provider === 'lmstudio') {
      const card = this.lmStudioInventory().find((c) => c.id === model);
      const live = card ? effectiveLmStudioContextTokens(card) : 0;
      if (live > 0) {
        contextWindowTokens = live;
      }
      // LM Studio ids can be snapshot hashes, which mean nothing wherever the name is shown.
      name = card?.displayName || model;
    } else if (loc.provider.provider === 'openai-compatible') {
      // Only a size the server reports replaces the one typed in; a model ID is no guide here.
      contextWindowTokens =
        this.openAiCompatModels().find((m) => m.id === model)?.contextLength ?? loc.model.contextWindowTokens;
    }
    this.applyLlmModelPatch(loc.model.id, {
      model,
      name,
      contextWindowTokens,
    });
    this.markSettingsDirty();
  }

  onTemperatureChange(raw: string | number): void {
    const n = typeof raw === 'number' ? raw : Number.parseFloat(raw);
    if (Number.isNaN(n)) {
      return;
    }
    const clamped = Math.min(1, Math.max(0, n));
    this.updateSelectedModel({ temperature: clamped });
  }

  presetsFor(provider: LlmProviderConfig['provider']) {
    return optimizationPresetsForProvider(provider);
  }

  providerKindLabel(provider: LlmProviderConfig): string {
    const kind = provider.provider;
    if (kind === 'lmstudio') {
      return 'LM Studio';
    }
    if (kind === 'openai-compatible') {
      return 'OpenAI-compatible';
    }
    if (kind === 'llamacpp') {
      return this.isManagedLlamacppSource(provider) ? 'Local Model' : 'OpenAI-compatible';
    }
    if (kind === 'openrouter') {
      return 'OpenRouter';
    }
    if (kind === 'anthropic') {
      return 'Anthropic';
    }
    return 'OpenAI';
  }

  /**
   * Whether a source row is a managed (non-URL-only) llamacpp provider — i.e. one
   * whose label mirrors the selected model and therefore participates in inventory
   * loading. Used to gate the inline source-label spinner in the sources list.
   */
  isManagedLlamacppSource(provider: LlmProviderConfig): boolean {
    return provider.provider === 'llamacpp' && !isPinnedLlamaServerUrlProviderId(provider.id);
  }

  /**
   * Display name for a source row in the Models sources list. A managed
   * (non-URL-only) llamacpp source shows its custom name when one is set, else
   * mirrors the model picked in its Local model dropdown — the inventory file
   * name for a GGUF/hub pick, or the HF id for an HF pick — falling back to the
   * stored provider name (a fixed default) when no model is selected. Other
   * providers show their stored name.
   */
  sourceDisplayName(provider: LlmProviderConfig): string {
    return managedLlamaSourceDisplayName(provider, this.modelManagerCustomModels());
  }

  /** Placeholder for a managed llamacpp source's Name field: the label it gets with no custom name. */
  sourceModelLabel(provider: LlmProviderConfig): string {
    return managedLlamaModelLabel(provider, this.modelManagerCustomModels());
  }

  presetDescription(connection: LlmConnectionConfig): string {
    return (
      optimizationPresetsForProvider(connection.provider).find((p) => p.id === connection.optimizationPreset)
        ?.description ?? ''
    );
  }

  formatTemperature(value: number): string {
    return Number.isFinite(value) ? value.toFixed(2) : '0.00';
  }

  onOptimizationPresetChange(value: string): void {
    const preset: LlmOptimizationPreset =
      value === 'qwen' ? 'qwen' : value === 'gemma' ? 'gemma' : 'generic';
    const model = this.selectedModel();
    if (!model) {
      return;
    }
    this.applyLlmModelPatch(
      model.id,
      optimizationPresetDefaultsPatch(preset) as Partial<LlmModelProfile>,
    );
    this.markSettingsDirty();
  }

  onOptionalTopPChange(raw: number | string | null): void {
    if (raw === null || raw === '' || (typeof raw === 'number' && Number.isNaN(raw))) {
      this.updateSelectedModel({ topP: undefined });
      return;
    }
    const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
    if (Number.isNaN(n)) {
      this.updateSelectedModel({ topP: undefined });
      return;
    }
    this.updateSelectedModel({ topP: Math.min(1, Math.max(0, n)) });
  }

  onOptionalTopKChange(raw: number | string | null): void {
    if (raw === null || raw === '' || (typeof raw === 'number' && Number.isNaN(raw))) {
      this.updateSelectedModel({ topK: undefined });
      return;
    }
    const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
    if (Number.isNaN(n)) {
      this.updateSelectedModel({ topK: undefined });
      return;
    }
    this.updateSelectedModel({ topK: Math.min(256, Math.max(1, Math.floor(n))) });
  }

  onOptionalMinPChange(raw: number | string | null): void {
    if (raw === null || raw === '' || (typeof raw === 'number' && Number.isNaN(raw))) {
      this.updateSelectedModel({ minP: undefined });
      return;
    }
    const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
    if (Number.isNaN(n)) {
      this.updateSelectedModel({ minP: undefined });
      return;
    }
    this.updateSelectedModel({ minP: Math.min(1, Math.max(0, n)) });
  }

  onOptionalPresencePenaltyChange(raw: number | string | null): void {
    if (raw === null || raw === '' || (typeof raw === 'number' && Number.isNaN(raw))) {
      this.updateSelectedModel({ presencePenalty: undefined });
      return;
    }
    const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
    if (Number.isNaN(n)) {
      this.updateSelectedModel({ presencePenalty: undefined });
      return;
    }
    this.updateSelectedModel({ presencePenalty: Math.min(2, Math.max(-2, n)) });
  }

  onOptionalRepeatPenaltyChange(raw: number | string | null): void {
    if (raw === null || raw === '' || (typeof raw === 'number' && Number.isNaN(raw))) {
      this.updateSelectedModel({ repeatPenalty: undefined });
      return;
    }
    const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
    if (Number.isNaN(n)) {
      this.updateSelectedModel({ repeatPenalty: undefined });
      return;
    }
    this.updateSelectedModel({ repeatPenalty: Math.min(4, Math.max(0.01, n)) });
  }

  onMaxOutputTokensChange(raw: string | number): void {
    const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
    if (Number.isNaN(n)) {
      return;
    }
    const clamped = Math.min(200_000, Math.max(0, n));
    this.updateSelectedModel({ maxOutputTokens: clamped });
  }

  onContextWindowTokensChange(raw: string | number): void {
    const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
    if (Number.isNaN(n)) {
      return;
    }
    const clamped = Math.min(10_000_000, Math.max(1_024, n));
    this.updateSelectedModel({ contextWindowTokens: clamped });
  }

  patchLlamaCppManaged(patch: Partial<LlamaCppManaged>): void {
    const m = this.selectedModel();
    if (!m) {
      return;
    }
    const base = m.llamaCppManaged ?? defaultLlamaCppManaged();
    this.updateSelectedModel({
      llamaCppManaged: { ...base, ...patch },
    });
  }

  /** Save the chat command, keeping the profile's context size in step with its ``-c``. */
  setManagedChatRunCommand(chatRunCommand: string): void {
    const m = this.selectedModel();
    if (!m) {
      return;
    }
    const base = m.llamaCppManaged ?? defaultLlamaCppManaged();
    const ctx = parseCustomManagedContextTokens(parseManagedLlamaContextSize(chatRunCommand) ?? '');
    this.updateSelectedModel({
      llamaCppManaged: { ...base, chatRunCommand },
      ...(ctx === null ? {} : { contextWindowTokens: ctx }),
    });
  }

  openModelManagerTab(): void {
    this.selectTab('modelManager');
  }

  onManagedInventoryPick(value: string): void {
    const v = (value || '').trim();
    if (!v) {
      return;
    }
    if (v.startsWith('gguf:')) {
      const absolutePath = v.slice('gguf:'.length);
      const fileName = absolutePath.split(/[/\\]/).pop() || absolutePath;
      this.applyManagedModelSource({ kind: 'gguf', absolutePath, displayName: fileName }, { keepCustomFlags: true });
      return;
    }
    if (v.startsWith('hub:')) {
      const absolutePath = v.slice('hub:'.length);
      const entry = this.modelManagerCustomModels().find((m) => m.absolutePath === absolutePath);
      const localGguf = (entry?.ggufAbsolutePath || '').trim();
      if (localGguf) {
        this.applyManagedModelSource(
          {
            kind: 'gguf',
            absolutePath: localGguf,
            displayName: entry?.fileName || localGguf.split(/[/\\]/).pop() || localGguf,
          },
          { keepCustomFlags: true },
        );
        return;
      }
      const folderName = entry?.fileName || absolutePath.split(/[/\\]/).pop() || absolutePath;
      this.applyManagedModelSource(
        {
          kind: 'hubRepo',
          absolutePath,
          folderName,
          displayName: folderName,
        },
        { keepCustomFlags: true },
      );
      return;
    }
    if (v.startsWith('hf:')) {
      const hfId = v.slice('hf:'.length);
      this.managedHfIdDraft.set(hfId);
      this.applyManagedModelSource({ kind: 'hf', hfId }, { keepCustomFlags: true });
    }
  }

  onManagedGpuOffloadChange(mode: ManagedGpuOffloadMode | string, cudaIndex?: number): void {
    if (mode !== 'auto' && mode !== 'single' && mode !== 'split') {
      return;
    }
    const cmd = this.selectedLlamaCppManaged().chatRunCommand;
    if (!cmd.trim()) {
      return;
    }
    this.patchLlamaCppManaged({
      chatRunCommand: promoteManagedSentinelNglToAuto(
        syncGpuOffloadInManagedChatCommand(
          cmd,
          mode,
          this.cudaGpus(),
          detectShellQuotingPlatform(),
          cudaIndex,
        ),
        detectShellQuotingPlatform(),
      ),
    });
  }

  onManagedNoMmprojChange(enabled: boolean | string): void {
    const cmd = this.selectedLlamaCppManaged().chatRunCommand;
    if (!cmd.trim()) {
      return;
    }
    const noMmproj = enabled === true || enabled === 'true';
    const sel = parseManagedLlamaModelSelection(cmd);
    const mmprojPath =
      !noMmproj && sel
        ? resolveMmprojPathForManagedSelection(sel, this.modelManagerCustomModels())
        : null;
    this.patchLlamaCppManaged({
      chatRunCommand: syncManagedVisionProjectorInChatCommand(
        cmd,
        { noMmproj, mmprojPath },
        detectShellQuotingPlatform(),
      ),
    });
  }

  cudaGpuLabel(gpu: CudaGpuDevice): string {
    return `${shortCudaGpuName(gpu.model)} (${formatGpuVramGb(gpu.memoryTotalMb)})`;
  }

  resetManagedToRecommended(): void {
    const sel = parseManagedLlamaModelSelection(this.selectedLlamaCppManaged().chatRunCommand);
    if (!sel) {
      return;
    }
    if (sel.kind === 'gguf') {
      const fileName = sel.absolutePath.split(/[/\\]/).pop() || sel.absolutePath;
      this.applyManagedModelSource({ kind: 'gguf', absolutePath: sel.absolutePath, displayName: fileName });
      return;
    }
    this.managedHfIdDraft.set(sel.hfId);
    const hub = this.modelManagerCustomModels().find((m) => {
      if (m.entryKind !== 'hubRepo') {
        return false;
      }
      const id = hubCacheFolderToHfId(m.fileName) || hubCacheFolderToHfId(m.absolutePath);
      const base = sel.hfId.split(':')[0] ?? sel.hfId;
      return !!id && (id === sel.hfId || id === base);
    });
    if (hub) {
      const localGguf = (hub.ggufAbsolutePath || '').trim();
      if (localGguf) {
        this.applyManagedModelSource({
          kind: 'gguf',
          absolutePath: localGguf,
          displayName: hub.fileName,
        });
        return;
      }
      this.applyManagedModelSource({
        kind: 'hubRepo',
        absolutePath: hub.absolutePath,
        folderName: hub.fileName,
        displayName: hub.fileName,
      });
      return;
    }
    this.applyManagedModelSource({ kind: 'hf', hfId: sel.hfId });
  }

  /** "Use in Models" gets a source of its own, selected and active, so existing sources stay as they are. */
  private activateNewLocalSourceForUse(): void {
    this.addProvider();
    const source = this.selectedProvider();
    if (source) {
      this.activateSource(source.id);
    }
  }

  useCustomModelInModels(model: ModelManagerFileEntry): void {
    this.selectTab('models');
    this.activateNewLocalSourceForUse();
    const localGguf = (model.ggufAbsolutePath || '').trim();
    if (localGguf) {
      this.applyManagedModelSource(
        {
          kind: 'gguf',
          absolutePath: localGguf,
          displayName: model.fileName,
        },
        { keepCustomFlags: true },
      );
    } else if (model.entryKind === 'hubRepo') {
      this.applyManagedModelSource(
        {
          kind: 'hubRepo',
          absolutePath: model.absolutePath,
          folderName: model.fileName,
          displayName: model.fileName,
        },
        { keepCustomFlags: true },
      );
    } else {
      this.applyManagedModelSource(
        {
          kind: 'gguf',
          absolutePath: model.absolutePath,
          displayName: model.fileName,
        },
        { keepCustomFlags: true },
      );
    }
    void this.refreshCustomModelCards();
  }

  useHfModelInModels(hfId: string): void {
    const id = (hfId || '').trim();
    if (!id) {
      return;
    }
    this.selectTab('models');
    this.activateNewLocalSourceForUse();
    this.managedHfIdDraft.set(id);
    this.applyManagedModelSource({ kind: 'hf', hfId: id }, { keepCustomFlags: true });
  }

  /** Show a Hub repo in the detail panel; loads its quant files and details on first pick. */
  selectHfModel(repoId: string): void {
    const id = (repoId || '').trim();
    if (!id) {
      return;
    }
    this.modelManagerSelection.set({ kind: 'hf', id });
    void this.loadHfFiles(id);
    void this.loadHfDetails(id);
  }

  /** Show a local model; ``repoId`` (from a ``models--owner--name`` folder) also loads Hub details. */
  selectLocalModel(model: ModelManagerFileEntry, repoId?: string | null): void {
    this.modelManagerSelection.set({ kind: 'local', path: model.absolutePath });
    if (repoId) {
      void this.loadHfDetails(repoId);
    }
  }

  private isSelectedLocalModel(model: ModelManagerFileEntry): boolean {
    const sel = this.modelManagerSelection();
    return sel?.kind === 'local' && sel.path === model.absolutePath;
  }

  /** Quant files for a repo; cached per id, retried after an error. */
  private async loadHfFiles(id: string): Promise<void> {
    const cached = this.modelManagerHfFilesByRepo()[id];
    const failed = Object.prototype.hasOwnProperty.call(this.modelManagerHfFilesErrorByRepo(), id);
    if ((cached && !failed) || this.modelManagerHfFilesBusyByRepo()[id]) {
      return;
    }
    this.modelManagerHfFilesBusyByRepo.update((m) => ({ ...m, [id]: true }));
    this.modelManagerHfFilesErrorByRepo.update((m) => {
      const next = { ...m };
      delete next[id];
      return next;
    });
    try {
      const res = await this.electron.modelManagerListHfFiles({
        id,
        token: this.modelManagerHfToken().trim(),
      });
      if (!res.ok) {
        this.modelManagerHfFilesErrorByRepo.update((m) => ({ ...m, [id]: res.error }));
        this.modelManagerHfFilesByRepo.update((m) => ({ ...m, [id]: [] }));
        return;
      }
      this.modelManagerHfFilesByRepo.update((m) => ({ ...m, [id]: res.files }));
    } catch (e) {
      this.modelManagerHfFilesErrorByRepo.update((m) => ({
        ...m,
        [id]: e instanceof Error ? e.message : String(e),
      }));
      this.modelManagerHfFilesByRepo.update((m) => ({ ...m, [id]: [] }));
    } finally {
      this.modelManagerHfFilesBusyByRepo.update((m) => {
        const next = { ...m };
        delete next[id];
        return next;
      });
    }
  }

  /** Repo details for the panel; cached per id, retried after an error. */
  private async loadHfDetails(id: string): Promise<void> {
    const cached = this.modelManagerHfDetailsById()[id];
    if (cached?.ok || this.modelManagerHfDetailsBusyById()[id]) {
      return;
    }
    this.modelManagerHfDetailsBusyById.update((m) => ({ ...m, [id]: true }));
    try {
      const res = await this.electron.modelManagerHfModelDetails({ id, token: this.modelManagerHfToken().trim() });
      this.modelManagerHfDetailsById.update((m) => ({ ...m, [id]: res }));
    } catch (e) {
      this.modelManagerHfDetailsById.update((m) => ({
        ...m,
        [id]: { ok: false, error: e instanceof Error ? e.message : String(e) },
      }));
    } finally {
      this.modelManagerHfDetailsBusyById.update((m) => {
        const next = { ...m };
        delete next[id];
        return next;
      });
    }
  }

  /** "Use in Models" for a specific quant/file from an expanded HF card. */
  useHfQuantInModels(repoId: string, file: HuggingFaceModelFile): void {
    const repo = (repoId || '').trim();
    if (!repo) {
      return;
    }
    const localPath = this.modelManagerHfDownloaded()[this.hfQuantDownloadId(repo, file)];
    if (localPath) {
      this.selectTab('models');
      this.activateNewLocalSourceForUse();
      this.applyManagedModelSource(
        {
          kind: 'gguf',
          absolutePath: localPath,
          displayName: file.fileName,
        },
        { keepCustomFlags: true },
      );
      return;
    }
    const quant = (file.quant || '').trim();
    const hfId = quant ? `${repo}:${quant}` : `${repo}:${file.fileName}`;
    this.useHfModelInModels(hfId);
  }

  /** Stable download id for a quant within a HF repo. */
  private hfQuantDownloadId(repoId: string, file: HuggingFaceModelFile): HfDownloadId {
    return `${repoId}/${file.fileName}`;
  }

  /** Whether a quant is currently downloading (progress bar should be shown). */
  isHfQuantDownloading(repoId: string, file: HuggingFaceModelFile): boolean {
    return !!this.modelManagerHfDownloads()[this.hfQuantDownloadId(repoId, file)];
  }

  /** Whether a quant finished downloading (Use in Models becomes primary action). */
  isHfQuantDownloaded(repoId: string, file: HuggingFaceModelFile): boolean {
    return !!this.modelManagerHfDownloaded()[this.hfQuantDownloadId(repoId, file)];
  }

  /** Download progress 0..1 for a quant; 0 when total is unknown. */
  hfQuantDownloadFraction(repoId: string, file: HuggingFaceModelFile): number {
    const id = this.hfQuantDownloadId(repoId, file);
    const d = this.modelManagerHfDownloads()[id];
    if (!d || !d.totalBytes || d.totalBytes <= 0) {
      return 0;
    }
    return Math.max(0, Math.min(1, d.receivedBytes / d.totalBytes));
  }

  /** Whole-number percent for the row's progress bar; null while the total size is unknown. */
  hfQuantDownloadPercent(repoId: string, file: HuggingFaceModelFile): number | null {
    const d = this.modelManagerHfDownloads()[this.hfQuantDownloadId(repoId, file)];
    if (!d || !d.totalBytes || d.totalBytes <= 0) {
      return null;
    }
    return Math.round(this.hfQuantDownloadFraction(repoId, file) * 1000) / 10;
  }

  /** Human-readable progress label for a downloading quant. */
  hfQuantDownloadLabel(repoId: string, file: HuggingFaceModelFile): string {
    const id = this.hfQuantDownloadId(repoId, file);
    const d = this.modelManagerHfDownloads()[id];
    if (!d) {
      return '';
    }
    const pct = d.totalBytes && d.totalBytes > 0 ? Math.round((d.receivedBytes / d.totalBytes) * 100) : null;
    const recv = this.formatFileSize(d.receivedBytes);
    const total = d.totalBytes != null ? this.formatFileSize(d.totalBytes) : '?';
    return pct != null ? `${pct}% · ${recv} / ${total}` : `${recv} / ${total}`;
  }

  /** Kick off a HF GGUF download into the configured custom models directory. */
  async downloadHfQuant(repoId: string, file: HuggingFaceModelFile): Promise<void> {
    const repo = (repoId || '').trim();
    const fileName = (file?.fileName || '').trim();
    if (!repo || !fileName) {
      return;
    }
    const customDir = (this.modelManagerCustomDir() || '').trim();
    if (!customDir) {
      this.modelManagerStatus.set('Set a custom models directory before downloading.');
      return;
    }
    const downloadId = this.hfQuantDownloadId(repo, file);
    if (this.modelManagerHfDownloads()[downloadId]) {
      return;
    }
    // The 'queued' progress event from the main process drives the bar; we do not
    // set optimistic state here. A second invoke that gets `ok:false` ("already
    // downloading") would otherwise wipe the entry that the first invoke's 'queued'
    // event legitimately created, hiding the bar while the download continues.
    const res = await this.electron.modelManagerDownloadHfFile({
      repoId: repo,
      fileName,
      customDir,
      token: this.modelManagerHfToken().trim(),
    });
    // Progress events drive the bar; this resolves only at completion.
    if (!res.ok) {
      this.modelManagerStatus.set(res.error);
    }
  }

  /** Cancel an in-flight HF quant download. */
  cancelHfQuantDownload(repoId: string, file: HuggingFaceModelFile): void {
    const id = this.hfQuantDownloadId(repoId, file);
    void this.electron.modelManagerCancelHfDownload({ downloadId: id });
  }

  /** Human-readable file size for the quant list. */
  formatFileSize(bytes: number | null | undefined): string {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
      return '—';
    }
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
  }

  private applyManagedModelSource(source: ManagedLlamaModelSource, opts: { keepCustomFlags?: boolean } = {}): void {
    const ensureLocal = (): LlmModelProfile | null => {
      const current = this.selectedModel();
      const p = this.selectedProvider();
      if (current && p?.provider === 'llamacpp' && !this.isUrlOnlyLlamacpp()) {
        return current;
      }
      const local = this.llmProviders().find((x) => this.isManagedLlamacppSource(x));
      if (!local?.models[0]) {
        return null;
      }
      this.selectedModelId.set(local.models[0].id);
      return this.selectedModel();
    };
    const model = ensureLocal();
    if (!model) {
      return;
    }
    const hint = managedLlamaSourceHint(source);
    const preset = inferOptimizationPresetFromModelHint(hint);
    const stored = model.llamaCppManaged ?? defaultLlamaCppManaged();
    // What the last model's plan wrote doesn't come along: a tune may never land (OK during its read), and -hf gets none.
    const storedSelection = parseManagedLlamaModelSelection(stored.chatRunCommand);
    const sameModel =
      source.kind === 'gguf' &&
      storedSelection?.kind === 'gguf' &&
      storedSelection.absolutePath === source.absolutePath.trim();
    const base: typeof stored =
      sameModel
        ? stored
        : {
            chatRunCommand: withoutAutoTunedFlags(stored.chatRunCommand, stored.autoTuned),
            embeddingRunCommand: stored.embeddingRunCommand,
          };
    const existingCtx = parseManagedLlamaContextSize(base.chatRunCommand);
    const ctxForCmd = existingCtx === null || existingCtx === 0 ? 0 : existingCtx;
    const ctxForProfile =
      ctxForCmd > 0 ? ctxForCmd : inferContextWindowTokens(hint, 'llamacpp');
    const platform = detectShellQuotingPlatform();
    const resolvedMmproj = resolveMmprojPathForManagedSource(source, this.modelManagerCustomModels());
    const sourceForCmd =
      source.kind === 'gguf'
        ? { ...source, mmprojAbsolutePath: resolvedMmproj ?? undefined }
        : source;
    let chatRunCommand = buildManagedLlamaChatCommand(sourceForCmd, ctxForCmd, platform);
    if (!chatRunCommand) {
      return;
    }
    const prevCmd = base.chatRunCommand;
    const prevNgl = parseManagedLlamaNgl(prevCmd);
    if (prevNgl !== null) {
      chatRunCommand = syncNglFlagInManagedChatCommand(chatRunCommand, prevNgl, platform);
    }
    chatRunCommand = syncNoHostFlagInManagedChatCommand(
      chatRunCommand,
      managedLlamaCommandHasNoHost(prevCmd),
    );
    const prevGpu = parseManagedLlamaGpuOffload(prevCmd);
    if (prevGpu.mode !== 'auto') {
      chatRunCommand = syncGpuOffloadFromParsed(chatRunCommand, prevGpu, platform);
    }
    const prevChatTemplate = parseManagedLlamaChatTemplateFile(prevCmd);
    if (prevChatTemplate) {
      chatRunCommand = syncChatTemplateFileInManagedChatCommand(chatRunCommand, prevChatTemplate, platform);
    }
    const prevFa = parseManagedLlamaFlashAttn(prevCmd);
    if (prevFa !== null) {
      chatRunCommand = syncFlashAttnInManagedChatCommand(chatRunCommand, prevFa, platform);
    }
    const noMmproj = managedLlamaCommandHasNoMmproj(prevCmd);
    const mmprojPath = noMmproj ? null : resolvedMmproj;
    chatRunCommand = syncManagedVisionProjectorInChatCommand(
      chatRunCommand,
      { noMmproj, mmprojPath },
      platform,
    );
    const prevBatch = parseManagedLlamaBatchSize(prevCmd);
    if (prevBatch !== null && prevBatch > 0) {
      chatRunCommand = syncBatchSizeInManagedChatCommand(chatRunCommand, prevBatch, platform);
    }
    const prevUbatch = parseManagedLlamaUbatchSize(prevCmd);
    if (prevUbatch !== null && prevUbatch > 0) {
      chatRunCommand = syncUbatchSizeInManagedChatCommand(chatRunCommand, prevUbatch, platform);
    }
    const prevCtk = parseManagedLlamaCacheTypeK(prevCmd);
    if (prevCtk) {
      chatRunCommand = syncCacheTypeKInManagedChatCommand(chatRunCommand, prevCtk, platform);
    }
    const prevCtv = parseManagedLlamaCacheTypeV(prevCmd);
    if (prevCtv) {
      chatRunCommand = syncCacheTypeVInManagedChatCommand(chatRunCommand, prevCtv, platform);
    }
    chatRunCommand = promoteManagedSentinelNglToAuto(chatRunCommand, platform);
    if (opts.keepCustomFlags) {
      chatRunCommand = carryCustomLlamaFlags(prevCmd, chatRunCommand);
    }
    const patch = optimizationPresetDefaultsPatch(preset) as Partial<LlmModelProfile>;
    this.applyLlmModelPatch(model.id, {
      ...patch,
      name: hint,
      model: model.model || 'local-model',
      contextWindowTokens: ctxForProfile,
      llamaCppManaged: {
        ...base,
        chatRunCommand,
      },
    });
    if (source.kind === 'hf') {
      this.managedHfIdDraft.set(source.hfId);
    }
    this.markSettingsDirty();
    const modelChanged =
      JSON.stringify(parseManagedLlamaModelSelection(prevCmd)) !==
      JSON.stringify(parseManagedLlamaModelSelection(chatRunCommand));
    void this.tuneManagedCommandAfterPick(model.id, chatRunCommand, opts.keepCustomFlags ? prevCmd : '', modelChanged);
  }

  private managedGgufProfileAt(path: string | null): GgufProfile | null {
    return path ? (this.managedGgufProfiles()[path] ?? null) : null;
  }

  /** Read a GGUF header for the estimates and checks. A failed read leaves an earlier one in place. */
  async loadManagedGgufProfile(path: string | null): Promise<GgufProfile | null> {
    if (!path) {
      return null;
    }
    const profile = await this.electron.llamaServerGgufProfile({ path });
    if (profile) {
      this.managedGgufProfiles.update((profiles) => ({ ...profiles, [path]: profile }));
    }
    return profile;
  }

  /**
   * The part of a pick that needs the GGUF header, which arrives after the pick is saved. A ``-hf`` model
   * may not be on disk yet, so it gets none of this. ``previous`` is the command whose custom flags the
   * pick carried over; empty when it dropped them. When the header can't be read, the last model's plan
   * still comes out, and a plan for this same model stays.
   */
  private async tuneManagedCommandAfterPick(
    modelId: string,
    picked: string,
    previous: string,
    modelChanged: boolean,
  ): Promise<void> {
    const sel = parseManagedLlamaModelSelection(picked);
    if (sel?.kind !== 'gguf') {
      return;
    }
    const companionPath = resolveMtpPathForManagedGguf(sel.absolutePath, this.modelManagerCustomModels());
    const projectorPath = parseManagedLlamaMmproj(picked);
    const [profile, companion, usage, projectorBytes] = await Promise.all([
      this.loadManagedGgufProfile(sel.absolutePath),
      this.loadManagedGgufProfile(companionPath),
      this.electron.llamaServerVramUsage(),
      projectorPath ? this.electron.llamaServerGgufSize({ path: projectorPath }) : null,
    ]);
    this.managedVramUsage.set(usage);
    const model = this.selectedModel();
    const managed = model?.llamaCppManaged;
    // The user may have picked or edited something else during the read.
    if (model?.id !== modelId || managed?.chatRunCommand !== picked || (!profile && !modelChanged)) {
      return;
    }
    const { command, autoTuned } = profile
      ? tunePickedManagedChatCommand(
          {
            command: picked,
            previous,
            autoTuned: managed.autoTuned,
            profile,
            companionPath,
            companion,
            projectorBytes,
            gpus: this.cudaGpus(),
            usage,
          },
          detectShellQuotingPlatform(),
        )
      : { command: withoutAutoTunedFlags(picked, managed.autoTuned), autoTuned: undefined };
    if (command === picked && JSON.stringify(autoTuned) === JSON.stringify(managed.autoTuned)) {
      return;
    }
    this.updateSelectedModel({
      contextWindowTokens:
        parseCustomManagedContextTokens(parseManagedLlamaContextSize(command) ?? '') ??
        inferContextWindowTokens(model.name, 'llamacpp'),
      llamaCppManaged: {
        chatRunCommand: command,
        embeddingRunCommand: managed.embeddingRunCommand,
        ...(autoTuned ? { autoTuned } : {}),
      },
    });
  }

  managedInventoryOptionValue(model: ModelManagerFileEntry): string {
    return model.entryKind === 'hubRepo' ? `hub:${model.absolutePath}` : `gguf:${model.absolutePath}`;
  }

  managedInventoryFamilyLabel(model: ModelManagerFileEntry): string {
    const hint =
      model.entryKind === 'hubRepo'
        ? hubCacheFolderToHfId(model.fileName) || model.fileName
        : model.fileName;
    const family = inferModelFamilyFromHint(hint);
    if (family === 'qwen') {
      return 'Qwen';
    }
    if (family === 'gemma') {
      return 'Gemma';
    }
    return 'Other';
  }

  formatModelBytes(sizeBytes: number): string {
    if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
      return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = sizeBytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
  }

  formatModelDate(modifiedMs: number): string {
    if (!Number.isFinite(modifiedMs)) {
      return '';
    }
    return new Date(modifiedMs).toLocaleString();
  }

  updateModelManagerConfig(
    changes: Partial<{
      customModelsDir: string;
      huggingFaceToken: string;
    }>,
  ): void {
    if (changes.customModelsDir !== undefined) {
      this.modelManagerCustomDir.set(changes.customModelsDir);
    }
    if (changes.huggingFaceToken !== undefined) {
      this.modelManagerHfToken.set(changes.huggingFaceToken);
    }
    this.markSettingsDirty();
  }

  /** Save the HF token now; main writes it to disk encrypted with the OS keychain when available. */
  async saveHfToken(token: string): Promise<void> {
    this.updateModelManagerConfig({ huggingFaceToken: token.trim() });
    await this.applySettings();
  }

  async pickModelManagerCustomDir(): Promise<void> {
    const selected = await this.electron.modelManagerPickCustomDir();
    if (!selected) {
      return;
    }
    this.updateModelManagerConfig({ customModelsDir: selected });
    await this.refreshModelManagerData({ clearStatus: false });
    this.modelManagerStatus.set('Custom model directory updated.');
  }

  async refreshModelManagerData(options?: { clearStatus?: boolean }): Promise<void> {
    if (options?.clearStatus !== false) {
      this.modelManagerStatus.set('');
    }
    void this.refreshSecretStorage();
    await this.refreshCustomModelCards();
  }

  /** Whether saved secrets are keychain-encrypted on this host, for the status badges. */
  async refreshSecretStorage(): Promise<void> {
    try {
      this.modelManagerSecretStorage.set(await this.electron.modelManagerSecretStorage());
    } catch {
      this.modelManagerSecretStorage.set(null);
    }
  }

  /**
   * When Vision projector is Auto, pin ``--mmproj`` on the current ``-m`` / ``-hf``
   * command once inventory has a local projector. No-ops if Off or already pinned.
   */
  private syncManagedMmprojFromInventory(): void {
    if (this.isUrlOnlyLlamacpp()) {
      return;
    }
    const cmd = this.selectedLlamaCppManaged().chatRunCommand;
    if (!cmd.trim() || managedLlamaCommandHasNoMmproj(cmd)) {
      return;
    }
    const sel = parseManagedLlamaModelSelection(cmd);
    if (!sel) {
      return;
    }
    const mmprojPath = resolveMmprojPathForManagedSelection(sel, this.modelManagerCustomModels());
    const current = parseManagedLlamaMmproj(cmd);
    if (mmprojPath) {
      if (current === mmprojPath) {
        return;
      }
    } else if (!current) {
      return;
    } else if (sel.kind !== 'gguf' || mmprojNameMatchesLanguage(current, sel.absolutePath)) {
      return;
    }
    this.patchLlamaCppManaged({
      chatRunCommand: syncManagedVisionProjectorInChatCommand(
        cmd,
        { noMmproj: false, mmprojPath },
        detectShellQuotingPlatform(),
      ),
    });
  }

  async refreshCustomModelCards(): Promise<void> {
    const requestGen = ++this.localInventoryRequestGen;
    const dir = this.modelManagerCustomDir().trim();
    if (!dir) {
      this.modelManagerCustomModels.set([]);
      this.localInventoryResult.set('ok');
      return;
    }
    this.localInventoryInflight.update((n) => n + 1);
    this.modelManagerLocalLoading.set(true);
    const startedAt = Date.now();
    try {
      const res = await this.electron.modelManagerListCustomModels({ customDir: dir });
      // An older scan must not overwrite a newer directory or its observed state.
      if (requestGen !== this.localInventoryRequestGen) return;
      if (res.ok) {
        this.modelManagerCustomModels.set(res.models);
        this.localInventoryResult.set(res.directoryMissing ? 'error' : 'ok');
        this.syncManagedMmprojFromInventory();
        if (res.directoryMissing) {
          this.modelManagerStatus.set(
            `Custom model directory does not exist (${res.resolvedDir ?? dir}). Create the folder or fix the path.`,
          );
        }
      } else {
        this.modelManagerCustomModels.set([]);
        this.localInventoryResult.set('error');
        this.modelManagerStatus.set(res.error);
      }
    } catch (error) {
      if (requestGen === this.localInventoryRequestGen) this.localInventoryResult.set('error');
      throw error;
    } finally {
      const elapsed = Date.now() - startedAt;
      if (elapsed < 350) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 350 - elapsed));
      }
      this.localInventoryInflight.update((n) => Math.max(0, n - 1));
      this.modelManagerLocalLoading.set(this.localInventoryInflight() > 0);
    }
  }

  async renameCustomModel(model: ModelManagerFileEntry): Promise<void> {
    const customDir = this.modelManagerCustomDir().trim();
    if (!customDir) {
      return;
    }
    const isHubRepo = model.entryKind === 'hubRepo';
    // Pre-fill with the base name, trimming the model extension so the user
    // edits just the meaningful part. The main process re-appends the original
    // extension (preserving its type — .gguf stays .gguf, .ggml stays .ggml)
    // if the user submits a name without a model extension.
    const trimmedBase = stripModelExtension(model.fileName);
    const originalExt = modelExtension(model.fileName);
    const extLabel = originalExt || '.gguf';
    const entered = await this.themedPrompt.open({
      title: isHubRepo ? 'Rename model folder' : 'Rename model file',
      message: isHubRepo
        ? 'Enter a new folder name. Hub repo folders are not given an extension.'
        : `Enter a new file name. The ${extLabel} extension is added automatically if omitted.`,
      value: trimmedBase,
      placeholder: isHubRepo ? 'folder-name' : `model-name${extLabel}`,
      confirmText: 'Rename',
    });
    if (entered == null) {
      return;
    }
    const nextName = entered.trim();
    if (!nextName || nextName === trimmedBase || nextName === model.fileName) {
      return;
    }
    this.modelManagerBusy.set(true);
    try {
      const res = await this.electron.modelManagerRenameModel({
        customDir,
        modelPath: model.absolutePath,
        newFileName: nextName,
      });
      if (!res.ok) {
        this.modelManagerStatus.set(res.error);
        return;
      }
      this.modelManagerStatus.set(`Renamed to ${res.model?.fileName ?? nextName}.`);
      if (res.model && this.isSelectedLocalModel(model)) {
        this.modelManagerSelection.set({ kind: 'local', path: res.model.absolutePath });
      }
      await this.refreshCustomModelCards();
    } finally {
      this.modelManagerBusy.set(false);
    }
  }

  async deleteCustomModel(model: ModelManagerFileEntry): Promise<void> {
    const customDir = this.modelManagerCustomDir().trim();
    if (!customDir) {
      return;
    }
    const confirmed =
      (await this.themedConfirm.open(
        customModelDeletePrompt({
          fileName: model.fileName,
          isHubRepo: model.entryKind === 'hubRepo',
        }),
      )) === 'confirm';
    if (!confirmed) {
      return;
    }
    this.modelManagerBusy.set(true);
    try {
      const res = await this.electron.modelManagerDeleteModel({
        customDir,
        modelPath: model.absolutePath,
      });
      if (!res.ok) {
        this.modelManagerStatus.set(res.error);
        return;
      }
      this.modelManagerStatus.set(`Deleted ${model.fileName}.`);
      if (this.isSelectedLocalModel(model)) {
        this.modelManagerSelection.set(null);
      }
      await this.refreshCustomModelCards();
    } finally {
      this.modelManagerBusy.set(false);
    }
  }

  async searchHuggingFaceModels(page = 0): Promise<void> {
    const query = this.modelManagerHfQuery().trim();
    const nextPage = Math.max(0, Math.floor(page));
    if (!query) {
      this.modelManagerHfRawResults.set([]);
      this.modelManagerHfPage.set(0);
      this.modelManagerHfTotalPages.set(0);
      this.modelManagerHfWindowStart.set(0);
      this.modelManagerHfHasMore.set(false);
      return;
    }
    this.modelManagerHfBusy.set(true);
    try {
      const limit = this.modelManagerHfPageSize;
      const res = await this.electron.modelManagerSearchHf({
        query,
        token: this.modelManagerHfToken().trim(),
        limit,
        skip: nextPage * limit,
        fileType: this.modelManagerHfFileType().trim(),
      });
      if (!res.ok) {
        this.modelManagerStatus.set(res.error);
        this.modelManagerHfRawResults.set([]);
        this.modelManagerHfHasMore.set(false);
        this.modelManagerHfTotalPages.set(0);
        return;
      }

      const totalPages =
        res.totalPages != null && res.totalPages >= 0
          ? res.totalPages
          : nextPage === 0
            ? res.models.length === 0
              ? 0
              : Math.max(nextPage + (res.hasMore ? 2 : 1), 1)
            : Math.max(this.modelManagerHfTotalPages(), nextPage + (res.hasMore ? 2 : 1));

      if (res.models.length === 0 && nextPage > 0) {
        const lastPage = Math.max(0, totalPages > 0 ? totalPages - 1 : nextPage - 1);
        this.modelManagerHfTotalPages.set(Math.max(lastPage + 1, 1));
        this.modelManagerHfHasMore.set(false);
        this.alignHfPageWindow(lastPage);
        if (lastPage !== this.modelManagerHfPage()) {
          this.modelManagerHfBusy.set(false);
          await this.searchHuggingFaceModels(lastPage);
          return;
        }
        this.modelManagerHfRawResults.set([]);
        this.modelManagerHfPage.set(lastPage);
        return;
      }

      this.modelManagerHfRawResults.set(res.models);
      this.modelManagerHfPage.set(nextPage);
      this.modelManagerHfTotalPages.set(totalPages);
      this.modelManagerHfHasMore.set(res.hasMore || nextPage + 1 < totalPages);
      if (nextPage === 0) {
        this.modelManagerHfWindowStart.set(0);
      }
      this.alignHfPageWindow(nextPage);
    } finally {
      this.modelManagerHfBusy.set(false);
    }
  }

  /** Toggle the filter panel open/closed. */
  toggleHfFilters(): void {
    this.modelManagerHfFiltersOpen.set(!this.modelManagerHfFiltersOpen());
  }

  /** File-type change is server-side → re-run the search from page 0. */
  onHfFileTypeChange(type: string): void {
    const next = (type || '').trim().toLowerCase();
    if (next === this.modelManagerHfFileType()) {
      return;
    }
    this.modelManagerHfFileType.set(next);
    if (this.modelManagerHfQuery().trim()) {
      void this.searchHuggingFaceModels(0);
    }
  }

  /** Numeric filters are client-side → just update the signal (computed re-filters). */
  onHfMinDownloadsChange(value: number): void {
    this.modelManagerHfMinDownloads.set(Math.max(0, Math.floor(value || 0)));
  }

  onHfMinLikesChange(value: number): void {
    this.modelManagerHfMinLikes.set(Math.max(0, Math.floor(value || 0)));
  }

  /** Reset all filters to their defaults. */
  resetHfFilters(): void {
    // Goes through the chip handler so a changed file type re-runs the Hub search.
    this.onHfFileTypeChange(DEFAULT_HF_FILE_TYPE);
    this.modelManagerHfMinDownloads.set(0);
    this.modelManagerHfMinLikes.set(0);
  }

  private alignHfPageWindow(page: number): void {
    const windowSize = this.modelManagerHfPageWindowSize;
    const lastPage = Math.max(0, this.modelManagerHfTotalPages() - 1);
    let start = this.modelManagerHfWindowStart();
    const end = start + windowSize - 1;
    if (page > end) {
      start += page - end;
    } else if (page < start) {
      start -= start - page;
    }
    const maxStart = Math.max(0, lastPage - windowSize + 1);
    this.modelManagerHfWindowStart.set(Math.max(0, Math.min(start, maxStart)));
  }

  /** Center the visible page-number window around `page` (clamped to total pages). */
  private centerHfPageWindow(page: number): void {
    const windowSize = this.modelManagerHfPageWindowSize;
    const lastPage = Math.max(0, this.modelManagerHfTotalPages() - 1);
    const idealStart = page - Math.floor((windowSize - 1) / 2);
    const maxStart = Math.max(0, lastPage - windowSize + 1);
    this.modelManagerHfWindowStart.set(Math.max(0, Math.min(idealStart, maxStart)));
  }

  /**
   * Recenter when navigating onto either window edge (and more pages exist beyond
   * that edge); otherwise keep the target page visible with a minimal shift.
   */
  private prepareHfPageWindowForNavigation(page: number): void {
    const lastPage = Math.max(0, this.modelManagerHfTotalPages() - 1);
    const windowStart = this.modelManagerHfWindowStart();
    const windowEnd = Math.min(windowStart + this.modelManagerHfPageWindowSize - 1, lastPage);
    const atTrailingEdge = page >= windowEnd && page < lastPage;
    const atLeadingEdge = page <= windowStart && page > 0;
    if (atTrailingEdge || atLeadingEdge) {
      this.centerHfPageWindow(page);
      return;
    }
    this.alignHfPageWindow(page);
  }

  searchHuggingFaceModelsPrevPage(): void {
    const page = this.modelManagerHfPage();
    if (page <= 0 || this.modelManagerHfBusy()) {
      return;
    }
    const prev = page - 1;
    this.prepareHfPageWindowForNavigation(prev);
    void this.searchHuggingFaceModels(prev);
  }

  searchHuggingFaceModelsNextPage(): void {
    if (this.modelManagerHfBusy()) {
      return;
    }
    const next = this.modelManagerHfPage() + 1;
    const lastPage = Math.max(0, this.modelManagerHfTotalPages() - 1);
    if (next > lastPage) {
      return;
    }
    this.prepareHfPageWindowForNavigation(next);
    void this.searchHuggingFaceModels(next);
  }

  searchHuggingFaceModelsGotoPage(page: number): void {
    if (this.modelManagerHfBusy()) {
      return;
    }
    const lastPage = Math.max(0, this.modelManagerHfTotalPages() - 1);
    if (page < 0 || page > lastPage) {
      return;
    }

    this.prepareHfPageWindowForNavigation(page);

    if (page !== this.modelManagerHfPage()) {
      void this.searchHuggingFaceModels(page);
    }
  }

  onModelManagerHfQueryChange(value: string): void {
    this.modelManagerHfQuery.set(value);
  }

  async refreshWhisperDownloadedModels(): Promise<void> {
    this.whisperRefreshInflight++;
    this.whisperModelsLoading.set(true);
    try {
      const res = await this.electron.depsList();
      const whisper = (res.dependencies ?? []).find((d) => d.id === 'whisper');
      const raw = whisper?.downloadedModels;
      const downloaded = Array.isArray(raw) ? raw.filter((id) => typeof id === 'string') : [];
      this.whisperDownloadedModels.set(downloaded);
      this.snapWhisperModelToDownloaded(downloaded);
    } catch {
      this.whisperDownloadedModels.set([]);
    } finally {
      this.whisperRefreshInflight = Math.max(0, this.whisperRefreshInflight - 1);
      if (this.whisperRefreshInflight === 0) {
        this.whisperModelsLoading.set(false);
      }
    }
  }

  private snapWhisperModelToDownloaded(downloaded: string[]): void {
    if (this.audioProvider() !== 'whisper') return;
    const next = pickWhisperSettingsModel(this.audioModel(), downloaded);
    if (next !== this.audioModel()) {
      // Align the dropdown with sizes on disk without marking dirty. Closing
      // Settings auto-persists dirty state; snapping here must not rewrite config.json.
      this.audioModel.set(next);
    }
  }

  updateAudioSettings(changes: Partial<AudioTranscriptionConfig>): void {
    if (changes.provider !== undefined) {
      this.audioProvider.set(changes.provider);
    }
    if (changes.baseUrl !== undefined) {
      this.audioBaseUrl.set(changes.baseUrl);
    }
    if (changes.model !== undefined) {
      this.audioModel.set(changes.model);
    }
    if (changes.apiKey !== undefined) {
      this.audioApiKey.set(unwrapSecret(changes.apiKey));
    }
    if (changes.talkInputDeviceId !== undefined) {
      this.talkInputDeviceId.set(changes.talkInputDeviceId || 'default');
    }
    if (changes.talkSilenceThresholdSeconds !== undefined) {
      const v = changes.talkSilenceThresholdSeconds;
      const n = typeof v === 'number' && !Number.isNaN(v) ? v : TALK_SILENCE_THRESHOLD_MIN;
      const clamped = Math.min(
        TALK_SILENCE_THRESHOLD_MAX,
        Math.max(TALK_SILENCE_THRESHOLD_MIN, n),
      );
      this.talkSilenceThresholdSeconds.set(+clamped.toFixed(1));
    }
    if (changes.ttsVoice !== undefined) {
      const s = typeof changes.ttsVoice === 'string' ? changes.ttsVoice.trim() : '';
      const def =
        this.ttsProvider() === 'openai-compatible' ? DEFAULT_OPENAI_TTS_VOICE : DEFAULT_KOKORO_TTS_VOICE;
      this.ttsVoice.set(s || def);
    }
    if (changes.ttsSpeechSpeed !== undefined) {
      this.ttsSpeechSpeed.set(clampTtsSpeechSpeed(changes.ttsSpeechSpeed));
    }
    if (changes.ttsProvider !== undefined) {
      const next = changes.ttsProvider === 'openai-compatible' ? 'openai-compatible' : 'kokoro';
      this.ttsProvider.set(next);
      if (next === 'openai-compatible' && /^[ab][fm]_[a-z0-9_]+$/i.test(this.ttsVoice())) {
        this.ttsVoice.set(DEFAULT_OPENAI_TTS_VOICE);
      }
      if (next === 'kokoro' && !/^[ab][fm]_[a-z0-9_]+$/i.test(this.ttsVoice())) {
        this.ttsVoice.set(DEFAULT_KOKORO_TTS_VOICE);
      }
    }
    if (changes.ttsBaseUrl !== undefined) {
      this.ttsBaseUrl.set(typeof changes.ttsBaseUrl === 'string' ? changes.ttsBaseUrl : DEFAULT_OPENAI_TTS_BASE_URL);
    }
    if (changes.ttsApiKey !== undefined) {
      this.ttsApiKey.set(unwrapSecret(changes.ttsApiKey));
    }
    if (changes.ttsDefaultInstructions !== undefined) {
      this.ttsDefaultInstructions.set(
        typeof changes.ttsDefaultInstructions === 'string' ? changes.ttsDefaultInstructions : '',
      );
    }
    this.markSettingsDirty();
  }

  onChatFontSizeRemChange(rem: number): void {
    const n = typeof rem === 'number' && !Number.isNaN(rem) ? rem : 0.9;
    const clamped = Math.min(1.6, Math.max(0.6, +n.toFixed(1)));
    this.chatFontSizeRem.set(clamped);
    this.markSettingsDirty();
  }

  onChatContainerSizeChange(size: ChatContainerSize): void {
    this.chatContainerSize.set(normalizeChatContainerSize(size));
    this.markSettingsDirty();
  }

  onChatThinkingDisplayChange(display: ChatThinkingDisplay): void {
    this.chatThinkingDisplay.set(normalizeChatThinkingDisplay(display));
    this.markSettingsDirty();
  }

  onUiFontSizeRemChange(rem: number): void {
    const clamped = clampUiFontSizeRem(rem);
    this.uiFontSizeRem.set(clamped);
    applyAppFontOverrides({
      uiFontSizeRem: clamped,
      uiFontFamily: this.uiFontFamily(),
      codeFontFamily: this.codeFontFamily(),
    });
    this.markSettingsDirty();
  }

  /** App-wide UI font (everything except Monaco + rendered code blocks). Applies live in this window. */
  onUiFontFamilyChange(stack: string): void {
    this.uiFontFamily.set(stack ?? '');
    applyAppFontOverrides({
      uiFontSizeRem: this.uiFontSizeRem(),
      uiFontFamily: this.uiFontFamily(),
      codeFontFamily: this.codeFontFamily(),
    });
    this.markSettingsDirty();
  }

  /** Code font: rendered markdown code blocks + overrides the Monaco editor's own fontFamily. */
  onCodeFontFamilyChange(stack: string): void {
    this.codeFontFamily.set(stack ?? '');
    applyAppFontOverrides({
      uiFontSizeRem: this.uiFontSizeRem(),
      uiFontFamily: this.uiFontFamily(),
      codeFontFamily: this.codeFontFamily(),
    });
    this.markSettingsDirty();
  }

  onTalkInputDeviceIdChange(deviceId: string): void {
    this.updateAudioSettings({ talkInputDeviceId: deviceId || 'default' });
  }

  decreaseTalkSilenceThreshold(): void {
    const next = Math.max(
      TALK_SILENCE_THRESHOLD_MIN,
      +(this.talkSilenceThresholdSeconds() - TALK_SILENCE_THRESHOLD_STEP).toFixed(1),
    );
    this.updateAudioSettings({ talkSilenceThresholdSeconds: next });
  }

  readonly ttsSpeechSpeedMin = TTS_SPEECH_SPEED_MIN;
  readonly ttsSpeechSpeedMax = TTS_SPEECH_SPEED_MAX;
  readonly ttsSpeechSpeedStep = 0.05;

  onTtsSpeechSpeedInput(value: number): void {
    this.updateAudioSettings({ ttsSpeechSpeed: clampTtsSpeechSpeed(value) });
  }

  increaseTalkSilenceThreshold(): void {
    const next = Math.min(
      TALK_SILENCE_THRESHOLD_MAX,
      +(this.talkSilenceThresholdSeconds() + TALK_SILENCE_THRESHOLD_STEP).toFixed(1),
    );
    this.updateAudioSettings({ talkSilenceThresholdSeconds: next });
  }

  private async refreshTalkAudioInputs(): Promise<void> {
    try {
      const temp = await navigator.mediaDevices.getUserMedia({ audio: true });
      temp.getTracks().forEach((t) => t.stop());
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices
        .filter((d) => d.kind === 'audioinput')
        .map((d, i) => ({
          deviceId: d.deviceId,
          label: d.label || `Microphone ${i + 1}`,
        }));
      const sel = this.talkInputDeviceId();
      const valid = sel === 'default' || inputs.some((d) => d.deviceId === sel);
      if (!valid && inputs.length) {
        this.updateAudioSettings({ talkInputDeviceId: 'default' });
      }
      this.talkAudioInputDevices.set(inputs);
      this.talkAudioInputsLoadError.set(inputs.length ? '' : 'No microphone detected');
    } catch {
      this.talkAudioInputDevices.set([]);
      this.talkAudioInputsLoadError.set('Microphone permission is required to list inputs');
    }
  }

  updateWorkspaceTools(changes: Partial<WorkspaceToolsConfig>): void {
    if (changes.editToolsMode !== undefined) {
      this.editToolsMode.set(changes.editToolsMode === 'strict' ? 'strict' : 'standard');
    }
    if (changes.maxFileReadLines !== undefined) {
      this.maxFileReadLines.set(changes.maxFileReadLines);
    }
    if (changes.maxSearchResults !== undefined) {
      this.maxSearchResults.set(changes.maxSearchResults);
    }
    if (changes.defaultWorkspaceEncoding !== undefined) {
      this.defaultWorkspaceEncoding.set(changes.defaultWorkspaceEncoding || 'utf-8');
    }
    if (changes.defaultWorkspaceNewline !== undefined) {
      const nl = changes.defaultWorkspaceNewline;
      this.defaultWorkspaceNewline.set(nl === 'crlf' || nl === 'preserve' ? nl : 'lf');
    }
    if (changes.allowStagingOverlayCommands !== undefined) {
      this.allowStagingOverlayCommands.set(!!changes.allowStagingOverlayCommands);
    }
    if (changes.commandLineExplainStep !== undefined) {
      this.commandLineExplainStep.set(!!changes.commandLineExplainStep);
    }
    if (changes.exposeAllWorkspaceFiles !== undefined) {
      this.exposeAllWorkspaceFiles.set(!!changes.exposeAllWorkspaceFiles);
    }
    if (changes.allowWebAccess !== undefined) {
      this.allowWebAccess.set(!!changes.allowWebAccess);
    }
    if (changes.searxngBaseUrl !== undefined) {
      this.searxngBaseUrl.set((changes.searxngBaseUrl || '').trim());
    }
    if (changes.webSearchProvider !== undefined) {
      this.webSearchProvider.set(changes.webSearchProvider ?? 'auto');
    }
    if (changes.webSearchEngines !== undefined) {
      this.webSearchEngines.set(normalizeWebSearchEngines(changes.webSearchEngines));
    }
    if (changes.webSearchUserAgent !== undefined) {
      this.webSearchUserAgent.set((changes.webSearchUserAgent || '').trim());
    }
    if (changes.webSearchCooldownSeconds !== undefined) {
      this.webSearchCooldownSeconds.set(changes.webSearchCooldownSeconds ?? 300);
    }
    if (changes.screenshotRetention !== undefined) {
      this.screenshotRetention.set(normalizeScreenshotRetention({
        ...this.screenshotRetention(), ...changes.screenshotRetention,
      }));
    }
    if (changes.extraUserPath !== undefined) {
      this.extraUserPath.set(changes.extraUserPath || '');
    }
    if (changes.enableAgentFormatters !== undefined) {
      this.enableAgentFormatters.set(!!changes.enableAgentFormatters);
    }
    this.markSettingsDirty();
  }

  onEditToolsModeChange(mode: 'standard' | 'strict'): void {
    this.editToolsMode.set(mode);
    this.markSettingsDirty();
  }

  onMaxFileReadLinesChange(raw: string | number): void {
    const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
    if (Number.isNaN(n)) {
      return;
    }
    const clamped = Math.min(2000, Math.max(50, n));
    this.maxFileReadLines.set(clamped);
    this.markSettingsDirty();
  }

  onMaxSearchResultsChange(raw: string | number): void {
    const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
    if (Number.isNaN(n)) {
      return;
    }
    const clamped = Math.min(200, Math.max(1, n));
    this.maxSearchResults.set(clamped);
    this.markSettingsDirty();
  }

  onDefaultWorkspaceEncodingChange(value: string): void {
    const v = (value || 'utf-8').trim() || 'utf-8';
    this.defaultWorkspaceEncoding.set(v);
    this.markSettingsDirty();
  }

  onDefaultWorkspaceNewlineChange(value: string): void {
    const v = value === 'crlf' || value === 'preserve' ? value : 'lf';
    this.defaultWorkspaceNewline.set(v);
    this.markSettingsDirty();
  }

  onAllowStagingOverlayCommandsChange(enabled: boolean): void {
    this.allowStagingOverlayCommands.set(!!enabled);
    this.markSettingsDirty();
  }

  onCommandLineExplainStepChange(enabled: boolean): void {
    this.commandLineExplainStep.set(!!enabled);
    this.markSettingsDirty();
  }

  onExposeAllWorkspaceFilesChange(enabled: boolean): void {
    this.exposeAllWorkspaceFiles.set(!!enabled);
    this.markSettingsDirty();
  }

  onAllowWebAccessChange(enabled: boolean): void {
    this.allowWebAccess.set(!!enabled);
    this.markSettingsDirty();
  }

  onSearxngBaseUrlChange(value: string): void {
    this.searxngBaseUrl.set((value || '').trim());
    this.markSettingsDirty();
  }

  onWebSearchProviderChange(value: string): void {
    this.webSearchProvider.set(value === 'internal' || value === 'searxng' ? value : 'auto');
    this.markSettingsDirty();
  }

  onWebSearchEngineToggle(id: string, enabled: boolean): void {
    const current = new Set(this.webSearchEngines());
    if (enabled) {
      current.add(id);
    } else {
      current.delete(id);
    }
    this.webSearchEngines.set(normalizeWebSearchEngines([...current]));
    this.markSettingsDirty();
  }

  onWebSearchUserAgentChange(value: string): void {
    this.webSearchUserAgent.set((value || '').trim());
    this.markSettingsDirty();
  }

  onWebSearchCooldownSecondsChange(raw: string | number): void {
    const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
    if (Number.isNaN(n)) {
      return;
    }
    this.webSearchCooldownSeconds.set(Math.min(3600, Math.max(0, n)));
    this.markSettingsDirty();
  }

  onScreenshotRetentionChange(key: keyof ScreenshotRetentionSettings, raw: string | number | null): void {
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(value) || raw === '' || raw === null) {
      return;
    }
    this.screenshotRetention.set(normalizeScreenshotRetention({ ...this.screenshotRetention(), [key]: value }));
    this.markSettingsDirty();
  }

  onExtraUserPathChange(value: string): void {
    this.extraUserPath.set(value || '');
    this.markSettingsDirty();
  }

  onEnableAgentFormattersChange(enabled: boolean): void {
    this.enableAgentFormatters.set(!!enabled);
    this.markSettingsDirty();
  }

  onConfirmMoveChange(enabled: boolean): void {
    this.confirmMove.set(!!enabled);
    this.confirmMoveTouched = true;
    this.markSettingsDirty();
  }

  onTutorialEnabledChange(enabled: boolean): void {
    this.tutorialEnabledDraft.set(!!enabled);
    this.markSettingsDirty();
  }

  updateContextCompression(changes: Partial<ContextCompressionConfig>): void {
    if (changes.enabled !== undefined) {
      this.contextCompressionEnabled.set(!!changes.enabled);
    }
    if (changes.triggerRatio !== undefined) {
      this.contextCompressionTriggerRatio.set(changes.triggerRatio);
    }
    if (changes.targetRatio !== undefined) {
      this.contextCompressionTargetRatio.set(changes.targetRatio);
    }
    this.markSettingsDirty();
  }

  onContextCompressionEnabledChange(enabled: boolean): void {
    this.updateContextCompression({ enabled: !!enabled });
  }

  onContextCompressionTriggerRatioChange(raw: string | number): void {
    const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
    if (Number.isNaN(n)) return;
    const clamped = Math.min(0.95, Math.max(0.5, n));
    this.contextCompressionTriggerRatio.set(clamped);
    const maxTarget = maxContextCompressionTarget(clamped);
    if (this.contextCompressionTargetRatio() > maxTarget) {
      this.contextCompressionTargetRatio.set(Math.min(maxTarget, 0.5));
    }
    this.markSettingsDirty();
  }

  onContextCompressionTargetRatioChange(raw: string | number): void {
    const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
    if (Number.isNaN(n)) return;
    const maxTarget = maxContextCompressionTarget(this.contextCompressionTriggerRatio());
    const clamped = Math.min(maxTarget, Math.max(0.4, Math.min(0.9, n)));
    this.contextCompressionTargetRatio.set(clamped);
    this.markSettingsDirty();
  }

  patchMonaco(patch: Partial<MonacoWorkspaceEditorSettings>): void {
    const merged = { ...this.monacoWorkspaceEditor(), ...patch };
    this.monacoWorkspaceEditor.set(normalizeMonacoWorkspaceEditorSettings(merged).settings);
    this.markSettingsDirty();
  }

  monacoEditorThemeLabel(id: MonacoWorkspaceEditorThemeId): string {
    return MONACO_EDITOR_THEME_LABELS[id];
  }

  monacoSubTabSummary(id: string): string {
    const s = this.monacoWorkspaceEditor();
    switch (id) {
      case 'theme':
        return this.monacoEditorThemeShortLabel(s.theme);
      case 'typography':
        return `${s.fontSize}px`;
      case 'wrapMinimap':
        return s.minimapEnabled ? 'Map on' : 'Map off';
      case 'display':
        return s.lineNumbers;
      case 'guides':
        return `Tab ${s.tabSize}`;
      case 'cursor':
        return s.cursorStyle;
      case 'editing':
        return s.quickSuggestions ? 'On' : 'Off';
      default:
        return '';
    }
  }

  monacoEditorThemeShortLabel(id: MonacoWorkspaceEditorThemeId): string {
    switch (id) {
      case 'follow-app':
        return 'App';
      case 'vs':
        return 'VS';
      case 'vs-dark':
        return 'Dark';
      case 'hc-black':
        return 'HC-';
      case 'hc-light':
        return 'HC+';
      default:
        return id;
    }
  }

  parseMonacoFloat(raw: string | number, fallback: number): number {
    const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
    return Number.isNaN(n) ? fallback : n;
  }

  parseMonacoInt(raw: string | number, fallback: number): number {
    const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
    return Number.isNaN(n) ? fallback : n;
  }

  onAudioProviderChange(provider: AudioTranscriptionProvider): void {
    if (provider === 'disabled') {
      this.audioProvider.set('disabled');
      this.markSettingsDirty();
      return;
    }

    if (provider === 'whisper') {
      this.audioProvider.set('whisper');
      const downloaded = this.whisperDownloadedModels();
      const persisted = isWhisperModelId(this.audioModel())
        ? this.audioModel()
        : DEFAULT_WHISPER_MODEL;
      this.audioModel.set(pickWhisperSettingsModel(persisted, downloaded));
      this.markSettingsDirty();
      void this.refreshWhisperDownloadedModels();
      return;
    }

    this.audioProvider.set('openai');
    if (isWhisperModelId(this.audioModel()) || !this.audioModel()) {
      this.audioModel.set(DEFAULT_OPENAI_TRANSCRIBE_MODEL);
    }
    this.markSettingsDirty();
  }

  sourceIsActive(provider: LlmProviderConfig): boolean {
    const activeId = this.activeLlmModelId();
    return provider.models.some((m) => m.id === activeId);
  }

  trackProvider(_index: number, provider: LlmProviderConfig): string {
    return provider.id;
  }

  trackWorkspace(_index: number, workspace: Workspace): string {
    return workspace.id;
  }

  private buildNewModel(index: number, providerKind: LlmProviderConfig['provider']): LlmModelProfile {
    const apiModel = defaultLlmModelId(providerKind);
    const base: LlmModelProfile = {
      id: crypto.randomUUID(),
      name: `Model ${index}`,
      model: apiModel,
      contextWindowTokens: inferContextWindowTokens(apiModel, providerKind),
      reasoningEffort: '',
      thinkingMode: 'default',
      samplingPreset: 'provider-default',
      architectureHint: 'auto',
      temperature: 0,
      parallelToolCalls: true,
      optimizationPreset: 'generic',
      maxOutputTokens: 0,
    };
    if (providerKind === 'llamacpp') {
      base.llamaCppManaged = {
        ...defaultLlamaCppManaged(),
        chatRunCommand: SettingsStore.newManagedLlamacppChatCommand,
      };
    }
    return base;
  }

  private buildNewLlamacppProvider(): LlmProviderConfig {
    const defaults = this.getProviderDefaults('llamacpp');
    const firstModel = this.buildNewModel(1, 'llamacpp');
    return {
      id: crypto.randomUUID(),
      name: uniqueManagedLlamaSourceName(this.llmProviders().map((p) => p.name)),
      provider: 'llamacpp',
      baseUrl: defaults.baseUrl,
      apiKey: defaults.apiKey,
      models: [firstModel],
    };
  }

  private getProviderDefaults(provider: LlmProviderConfig['provider']): Pick<LlmProviderConfig, 'baseUrl' | 'apiKey'> {
    if (provider === 'lmstudio') {
      return {
        baseUrl: 'http://127.0.0.1:1234/v1',
        apiKey: SecretValue.of('lm-studio'),
      };
    }
    if (provider === 'llamacpp') {
      return {
        baseUrl: 'http://127.0.0.1:8080/v1',
        apiKey: SecretValue.of(''),
      };
    }

    return {
      baseUrl: '',
      apiKey: SecretValue.of(''),
    };
  }

  addMcpServer(): void {
    this.mcpServers.update((list) => [...list, createEmptyMcpServer(crypto.randomUUID())]);
    this.markSettingsDirty();
  }

  removeMcpServer(id: string): void {
    this.mcpServers.update((list) => list.filter((server) => server.id !== id));
    this.markSettingsDirty();
  }

  patchMcpServer(
    id: string,
    patch: Partial<McpServerConfig>,
    touch?: 'trust' | 'decisions' | 'oauth',
  ): void {
    this.mcpServers.update((list) =>
      list.map((server) => {
        if (server.id !== id) {
          return server;
        }
        return {
          ...server,
          ...patch,
          trustTouched: touch === 'trust' ? true : server.trustTouched,
          toolDecisionsTouched: touch === 'decisions' ? true : server.toolDecisionsTouched,
          oauthTouched: touch === 'oauth' ? true : server.oauthTouched,
        };
      }),
    );
    this.markSettingsDirty();
  }

  setMcpSecretEntry(
    id: string,
    field: 'env' | 'headers',
    index: number,
    patch: { key?: string; value?: string },
  ): void {
    const server = this.mcpServers().find((entry) => entry.id === id);
    if (!server) {
      return;
    }
    const rows = server[field].map((entry, rowIndex) => {
      if (rowIndex !== index) {
        return entry;
      }
      return {
        key: patch.key !== undefined ? patch.key : entry.key,
        value: patch.value !== undefined ? SecretValue.of(patch.value) : entry.value,
      };
    });
    this.patchMcpServer(id, { [field]: rows });
  }

  addMcpSecretEntry(id: string, field: 'env' | 'headers'): void {
    const server = this.mcpServers().find((entry) => entry.id === id);
    if (!server) {
      return;
    }
    this.patchMcpServer(id, { [field]: [...server[field], { key: '', value: SecretValue.of('') }] });
  }

  removeMcpSecretEntry(id: string, field: 'env' | 'headers', index: number): void {
    const server = this.mcpServers().find((entry) => entry.id === id);
    if (!server) {
      return;
    }
    this.patchMcpServer(id, { [field]: server[field].filter((_, rowIndex) => rowIndex !== index) });
  }

  setMcpToolDecision(id: string, toolName: string, decision: McpToolDecision | 'ask'): void {
    const server = this.mcpServers().find((entry) => entry.id === id);
    if (!server) {
      return;
    }
    const toolDecisions = { ...server.toolDecisions };
    if (decision === 'ask') {
      delete toolDecisions[toolName];
    } else {
      toolDecisions[toolName] = decision;
    }
    this.patchMcpServer(id, { toolDecisions }, 'decisions');
  }

  async refreshMcpStatus(): Promise<void> {
    const result = await this.electron.mcpStatus();
    if (!result.ok) {
      this.mcpStatusError.set(result.error);
      return;
    }
    this.mcpStatusError.set('');
    this.mcpStatus.set(result.status);
  }

  /** Apply first when the list is dirty so Python sees the saved server, then open the browser. */
  async signInMcp(id: string): Promise<string> {
    if (this.settingsDirty()) {
      await this.applySettings();
    }
    this.mcpOauthBusyId.set(id);
    try {
      const result = await this.electron.mcpOauthStart(id);
      if (!result.ok) {
        return result.error;
      }
      const saved = result.config.mcpServers?.find((server) => server.id === id);
      if (saved?.oauth) {
        this.mcpServers.update((list) =>
          list.map((server) => (server.id === id ? { ...server, oauth: saved.oauth, httpAuth: 'oauth' } : server)),
        );
        if (this.configSnapshot) {
          this.configSnapshot.mcpServers = this.mcpServers().map((server) => ({ ...server }));
        }
      }
      await this.refreshMcpStatus();
      return '';
    } finally {
      this.mcpOauthBusyId.set('');
    }
  }

  mcpStatusFor(id: string) {
    return this.mcpStatus()?.servers.find((server) => server.id === id) ?? null;
  }

  private markSettingsDirty(): void {
    this.dirtyRevision += 1;
    this.settingsDirty.set(true);
  }

  private async enqueuePersist(): Promise<void> {
    // Theme file first so the saved `themeId` always points at an on-disk document.
    await this.themes$.persistIfDirty();
    const revision = this.dirtyRevision;
    const next = this.buildConfigForPersist();
    const tutorialEnabled = this.tutorialEnabledDraft();
    const saved = await this.electron.saveConfig(next);
    if (!saved) {
      return;
    }
    if (tutorialEnabled !== null) {
      // Tour progress is deliberately not part of a config save; a failure here leaves the window dirty.
      await this.electron.setTutorialEnabled(tutorialEnabled);
      if (this.tutorialEnabledDraft() === tutorialEnabled) {
        this.tutorialEnabledDraft.set(null);
      }
    }
    this.configSnapshot = structuredClone(saved);
    if (Array.isArray(saved.llmProviders)) {
      this.persistedSourceIds.set(new Set(saved.llmProviders.map((provider) => provider.id)));
    }
    // A change made during the save, such as a plan landing, isn't in what was saved.
    if (this.dirtyRevision === revision) {
      this.settingsDirty.set(false);
    }
    this.confirmMoveTouched = false;
    this.themes$.afterPersist();
    // Disk-owned workspace registry may differ from the client payload; skip
    // forceFull hydrate so Apply does not re-list llama/HF models after save.
    this.workspaces.set(saved.workspaces);
    const currentWorkspace =
      saved.workspaces.find((workspace) => workspace.id === saved.currentWorkspaceId) ?? null;
    this.currentWorkspace.set(currentWorkspace);
  }

  private buildConfigForPersist(): AppConfig {
    if (!this.configSnapshot) {
      throw new Error('Settings config snapshot not initialized');
    }
    const base = structuredClone(this.configSnapshot);
    return {
      ...base,
      chatFontSizeRem: this.chatFontSizeRem(),
      chatContainerSize: this.chatContainerSize(),
      chatThinkingDisplay: this.chatThinkingDisplay(),
      uiFontSizeRem: this.uiFontSizeRem(),
      uiFontFamily: this.uiFontFamily(),
      codeFontFamily: this.codeFontFamily(),
      workspaces: this.workspaces(),
      currentWorkspaceId: this.currentWorkspace()?.id ?? base.currentWorkspaceId,
      themeId: this.themeId(),
      activeLlmModelId: this.activeLlmModelId(),
      llmProviders: structuredClone(this.llmProviders()).map((p) =>
        isPinnedLmStudioProviderId(p.id)
          ? { ...p, provider: 'lmstudio', apiKey: SecretValue.of((p.apiKey && unwrapSecret(p.apiKey).trim()) || 'lm-studio') }
          : p,
      ),
      audioTranscription: {
        provider: this.audioProvider(),
        baseUrl: this.audioBaseUrl(),
        model: this.audioModel(),
        apiKey: SecretValue.of(this.audioApiKey()),
        talkInputDeviceId: this.talkInputDeviceId(),
        talkSilenceThresholdSeconds: this.talkSilenceThresholdSeconds(),
        ttsVoice: this.ttsVoice(),
        ttsSpeechSpeed: this.ttsSpeechSpeed(),
        ttsProvider: this.ttsProvider(),
        ttsBaseUrl: this.ttsBaseUrl(),
        ttsApiKey: SecretValue.of(this.ttsApiKey()),
        ttsDefaultInstructions: this.ttsDefaultInstructions(),
      },
      workspaceTools: {
        editToolsMode: this.editToolsMode(),
        maxFileReadLines: this.maxFileReadLines(),
        maxSearchResults: this.maxSearchResults(),
        defaultWorkspaceEncoding: this.defaultWorkspaceEncoding(),
        defaultWorkspaceNewline: this.defaultWorkspaceNewline(),
        allowStagingOverlayCommands: this.allowStagingOverlayCommands(),
        commandLineExplainStep: this.commandLineExplainStep(),
        exposeAllWorkspaceFiles: this.exposeAllWorkspaceFiles(),
        allowWebAccess: this.allowWebAccess(),
        searxngBaseUrl: this.searxngBaseUrl(),
        webSearchProvider: this.webSearchProvider(),
        webSearchEngines: this.webSearchEngines(),
        webSearchUserAgent: this.webSearchUserAgent(),
        webSearchCooldownSeconds: this.webSearchCooldownSeconds(),
        screenshotRetention: normalizeScreenshotRetention(this.screenshotRetention()),
        extraUserPath: this.extraUserPath(),
        enableAgentFormatters: this.enableAgentFormatters(),
      },
      confirmMove: this.confirmMove(),
      contextCompression: {
        enabled: this.contextCompressionEnabled(),
        triggerRatio: this.contextCompressionTriggerRatio(),
        targetRatio: this.contextCompressionTargetRatio(),
      },
      modelManager: {
        customModelsDir: this.modelManagerCustomDir(),
        huggingFaceToken: SecretValue.of(this.modelManagerHfToken()),
      },
      mcpServers: this.mcpServers().map((server) => ({
        ...server,
        env: server.env.map((entry) => ({ key: entry.key, value: SecretValue.of(unwrapSecret(entry.value)) })),
        headers: server.headers.map((entry) => ({ key: entry.key, value: SecretValue.of(unwrapSecret(entry.value)) })),
        oauth: server.oauth
          ? {
              ...server.oauth,
              accessToken: SecretValue.of(unwrapSecret(server.oauth.accessToken)),
              refreshToken: SecretValue.of(unwrapSecret(server.oauth.refreshToken)),
              clientSecret: SecretValue.of(unwrapSecret(server.oauth.clientSecret)),
            }
          : null,
      })),
      monacoWorkspaceEditor: structuredClone(this.monacoWorkspaceEditor()),
    };
  }

  private applyLlmModelPatch(modelId: string, changes: Partial<LlmModelProfile>): void {
    this.llmProviders.update((providers) =>
      providers.map((p) => ({
        ...p,
        models: p.models.map((m) => {
          if (m.id !== modelId) {
            return m;
          }
          const next: LlmModelProfile = { ...m };
          const draft = next as unknown as Record<string, unknown>;
          for (const [key, val] of Object.entries(changes) as [keyof LlmModelProfile, unknown][]) {
            if (val === undefined) {
              delete draft[key as string];
            } else {
              draft[key as string] = val;
            }
          }
          return next;
        }),
      })),
    );
  }

  private applyProviderPatch(
    providerId: string,
    changes: Partial<
      Pick<
        LlmProviderConfig,
        'name' | 'customName' | 'provider' | 'baseUrl' | 'apiKey' | 'embeddingsModel' | 'embeddingsBaseUrl'
      >
    >,
  ): void {
    this.llmProviders.update((providers) =>
      providers.map((p) => (p.id === providerId ? { ...p, ...changes } : p)),
    );
  }

  private syncFromConfig(config: AppConfig, forceFull: boolean): void {
    // Track persisted identities even when editable hydration is blocked by an unsaved draft.
    this.persistedSourceIds.set(new Set(config.llmProviders.map((provider) => provider.id)));
    const blockEditableHydration = !forceFull && this.settingsDirty();
    if (blockEditableHydration) {
      this.workspaces.set(config.workspaces);
      const currentWorkspace =
        config.workspaces.find((workspace) => workspace.id === config.currentWorkspaceId) ?? null;
      this.currentWorkspace.set(currentWorkspace);
      if (this.configSnapshot) {
        this.configSnapshot.workspaces = structuredClone(config.workspaces);
        this.configSnapshot.currentWorkspaceId = config.currentWorkspaceId;
        this.configSnapshot.themeId = config.themeId;
        this.configSnapshot.chatSidebarCollapsed = config.chatSidebarCollapsed;
        this.configSnapshot.chatExpandedToMainPanel = config.chatExpandedToMainPanel;
        this.configSnapshot.defaultHomePageOnStart = config.defaultHomePageOnStart;
        this.configSnapshot.confirmMove = config.confirmMove;
      }
      // The move prompt's "Don't ask again" lands here while this window is dirty. Adopt it unless
      // the user changed the toggle themselves, otherwise Apply would re-enable the prompt.
      if (!this.confirmMoveTouched) {
        this.confirmMove.set(config.confirmMove !== false);
      }
      this.themeId.set(resolveLegacyThemeId(config.themeId || DEFAULT_THEME_ID));
      const at = config.audioTranscription;
      this.ttsProvider.set(at?.ttsProvider === 'openai-compatible' ? 'openai-compatible' : DEFAULT_TTS_PROVIDER);
      this.ttsBaseUrl.set(at?.ttsBaseUrl?.trim() || DEFAULT_OPENAI_TTS_BASE_URL);
      this.ttsApiKey.set(unwrapSecret(at?.ttsApiKey));
      this.ttsDefaultInstructions.set(at?.ttsDefaultInstructions ?? '');
      const defaultVoice =
        this.ttsProvider() === 'openai-compatible' ? DEFAULT_OPENAI_TTS_VOICE : DEFAULT_KOKORO_TTS_VOICE;
      this.ttsVoice.set(at?.ttsVoice?.trim() || defaultVoice);
      this.ttsSpeechSpeed.set(clampTtsSpeechSpeed(at?.ttsSpeechSpeed));
      const cfs = config.chatFontSizeRem;
      this.chatFontSizeRem.set(
        typeof cfs === 'number' && !Number.isNaN(cfs) ? Math.min(1.6, Math.max(0.6, +cfs.toFixed(1))) : 0.9,
      );
      this.chatContainerSize.set(normalizeChatContainerSize(config.chatContainerSize));
      this.chatThinkingDisplay.set(normalizeChatThinkingDisplay(config.chatThinkingDisplay));
      this.uiFontSizeRem.set(clampUiFontSizeRem(config.uiFontSizeRem));
      this.uiFontFamily.set(typeof config.uiFontFamily === 'string' ? config.uiFontFamily : '');
      this.codeFontFamily.set(typeof config.codeFontFamily === 'string' ? config.codeFontFamily : '');
      applyAppFontOverrides({
        uiFontSizeRem: this.uiFontSizeRem(),
        uiFontFamily: this.uiFontFamily(),
        codeFontFamily: this.codeFontFamily(),
      });
      this.monacoWorkspaceEditor.set(
        normalizeMonacoWorkspaceEditorSettings(config.monacoWorkspaceEditor ?? undefined).settings,
      );
      this.modelManagerCustomDir.set(config.modelManager.customModelsDir);
      this.modelManagerHfToken.set(unwrapSecret(config.modelManager.huggingFaceToken));
      return;
    }

    this.configSnapshot = structuredClone(config);
    this.confirmMoveTouched = false;
    this.tutorialEnabledDraft.set(null);
    this.workspaces.set(config.workspaces);

    const currentWorkspace = config.workspaces.find((workspace) => workspace.id === config.currentWorkspaceId) ?? null;
    this.currentWorkspace.set(currentWorkspace);
    this.themeId.set(resolveLegacyThemeId(config.themeId || DEFAULT_THEME_ID));
    this.llmProviders.set(config.llmProviders);
    this.activeLlmModelId.set(config.activeLlmModelId);
    this.audioProvider.set(config.audioTranscription.provider);
    this.audioBaseUrl.set(config.audioTranscription.baseUrl);
    this.audioModel.set(config.audioTranscription.model);
    this.audioApiKey.set(unwrapSecret(config.audioTranscription.apiKey));
    void this.refreshWhisperDownloadedModels();
    const at = config.audioTranscription;
    this.talkInputDeviceId.set(at.talkInputDeviceId ?? 'default');
    const thr = at.talkSilenceThresholdSeconds;
    this.talkSilenceThresholdSeconds.set(
      typeof thr === 'number' && !Number.isNaN(thr)
        ? Math.min(
            TALK_SILENCE_THRESHOLD_MAX,
            Math.max(TALK_SILENCE_THRESHOLD_MIN, +thr.toFixed(1)),
          )
        : 2,
    );
    this.ttsProvider.set(at.ttsProvider === 'openai-compatible' ? 'openai-compatible' : DEFAULT_TTS_PROVIDER);
    this.ttsBaseUrl.set(at.ttsBaseUrl?.trim() || DEFAULT_OPENAI_TTS_BASE_URL);
    this.ttsApiKey.set(unwrapSecret(at.ttsApiKey ?? ''));
    this.ttsDefaultInstructions.set(at.ttsDefaultInstructions ?? '');
    const defaultVoice =
      this.ttsProvider() === 'openai-compatible' ? DEFAULT_OPENAI_TTS_VOICE : DEFAULT_KOKORO_TTS_VOICE;
    this.ttsVoice.set(at.ttsVoice?.trim() || defaultVoice);
    this.ttsSpeechSpeed.set(clampTtsSpeechSpeed(at.ttsSpeechSpeed));

    const cfs = config.chatFontSizeRem;
    this.chatFontSizeRem.set(
      typeof cfs === 'number' && !Number.isNaN(cfs) ? Math.min(1.6, Math.max(0.6, +cfs.toFixed(1))) : 0.9,
    );
    this.chatContainerSize.set(normalizeChatContainerSize(config.chatContainerSize));
    this.chatThinkingDisplay.set(normalizeChatThinkingDisplay(config.chatThinkingDisplay));
    this.uiFontSizeRem.set(clampUiFontSizeRem(config.uiFontSizeRem));
    this.uiFontFamily.set(typeof config.uiFontFamily === 'string' ? config.uiFontFamily : '');
    this.codeFontFamily.set(typeof config.codeFontFamily === 'string' ? config.codeFontFamily : '');
    applyAppFontOverrides({
      uiFontSizeRem: this.uiFontSizeRem(),
      uiFontFamily: this.uiFontFamily(),
      codeFontFamily: this.codeFontFamily(),
    });

    this.monacoWorkspaceEditor.set(
      normalizeMonacoWorkspaceEditorSettings(config.monacoWorkspaceEditor ?? undefined).settings,
    );

    const wt = config.workspaceTools;
    this.editToolsMode.set(wt.editToolsMode === 'strict' ? 'strict' : 'standard');
    this.maxFileReadLines.set(wt.maxFileReadLines);
    this.maxSearchResults.set(wt.maxSearchResults);
    this.defaultWorkspaceEncoding.set(wt.defaultWorkspaceEncoding || 'utf-8');
    const nl = wt.defaultWorkspaceNewline;
    this.defaultWorkspaceNewline.set(
      nl === 'crlf' || nl === 'preserve' ? nl : 'lf',
    );
    this.mcpServers.set(config.mcpServers ?? []);
    this.allowStagingOverlayCommands.set(!!(wt.allowStagingOverlayCommands ?? false));
    this.commandLineExplainStep.set(!!(wt.commandLineExplainStep ?? false));
    this.exposeAllWorkspaceFiles.set(!!(wt.exposeAllWorkspaceFiles ?? false));
    this.allowWebAccess.set(!!(wt.allowWebAccess ?? false));
    this.searxngBaseUrl.set((wt.searxngBaseUrl ?? '').trim());
    this.webSearchProvider.set(wt.webSearchProvider ?? 'auto');
    this.webSearchEngines.set(normalizeWebSearchEngines(wt.webSearchEngines));
    this.webSearchUserAgent.set((wt.webSearchUserAgent ?? '').trim());
    this.webSearchCooldownSeconds.set(wt.webSearchCooldownSeconds ?? 300);
    this.screenshotRetention.set(normalizeScreenshotRetention(wt.screenshotRetention));
    this.extraUserPath.set(wt.extraUserPath ?? '');
    this.enableAgentFormatters.set(!!(wt.enableAgentFormatters ?? false));
    this.confirmMove.set(config.confirmMove !== false);

    const cc = config.contextCompression ?? getDefaultContextCompression();
    this.contextCompressionEnabled.set(!!cc.enabled);
    this.contextCompressionTriggerRatio.set(cc.triggerRatio);
    this.contextCompressionTargetRatio.set(cc.targetRatio);

    this.modelManagerCustomDir.set(config.modelManager.customModelsDir);
    this.modelManagerHfToken.set(unwrapSecret(config.modelManager.huggingFaceToken));

    const currentSelected = this.selectedModelId();
    const selectedStillValid =
      currentSelected && config.llmProviders.some((p) => p.models.some((m) => m.id === currentSelected));
    const nextSelected = selectedStillValid
      ? currentSelected
      : config.activeLlmModelId;
    this.selectedModelId.set(nextSelected);

    const sid = (nextSelected ?? config.activeLlmModelId) || '';
    const locAfter = sid ? findLlmModelLocation(config.llmProviders, sid) : null;
    if (locAfter?.provider.provider === 'lmstudio') {
      void this.refreshLmStudioInventory();
    } else {
      this.clearLmStudioInventory();
    }

    if (locAfter?.provider.provider === 'openai-compatible') {
      void this.refreshOpenAiCompatModels();
    }
    if (locAfter?.provider.provider === 'llamacpp' && locAfter.model) {
      this.llamacppUrlEmbeddingModelIds.set([]);
      void this.refreshLlamacppManagedModels();
    } else {
      this.llamacppManagedModelIds.set([]);
      this.llamacppUrlEmbeddingModelIds.set([]);
      this.llamacppModelsListError.set(null);
    }

    if (this.selectedSettingsTab() === 'modelManager') {
      void this.refreshModelManagerData();
    } else if (this.selectedSettingsTab() === 'audio') {
      void this.refreshWhisperDownloadedModels();
    } else if (forceFull && this.selectedSettingsTab() === 'models') {
      // The models tab opens by default; selectTab() is never invoked on first
      // load, so the local model inventory would otherwise stay empty until the
      // user clicks away and back.
      void this.refreshCustomModelCards();
    }
  }
}
