import {
  afterNextRender,
  Component,
  effect,
  inject,
  Injector,
  OnDestroy,
  OnInit,
  computed,
  signal,
  untracked,
} from '@angular/core';
import { NgxSpinnerComponent, NgxSpinnerService } from 'ngx-spinner';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import type {
  AppConfig,
  AudioTranscriptionConfig,
  ChatContainerSize,
  FontFamilyOption,
  HuggingFaceModelSearchItem,
  LlamaCppManaged,
  LlmConnectionConfig,
  LlmModelProfile,
  LlmOptimizationPreset,
  LlmProviderConfig,
  LmStudioModelCard,
  ModelManagerCacheLocation,
  ModelManagerFileEntry,
  ModelManagerMigrateProgressPayload,
  MonacoWorkspaceEditorSettings,
  MonacoWorkspaceEditorThemeId,
  SystemFontInfo,
  Workspace,
  WorkspaceToolsConfig,
  ContextCompressionConfig,
  TtsProvider,
} from '@shared/index';
import {
  CAPABLE_PRESET_DEFAULTS,
  CHAT_CONTAINER_SIZE_OPTIONS,
  CODE_FONT_FAMILY_OPTIONS,
  DEFAULT_CHAT_CONTAINER_SIZE,
  DEFAULT_MANAGED_LLAMA_CHAT_RUN_COMMAND,
  getDefaultContextCompression,
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
  defaultMonacoWorkspaceEditorSettings,
  defaultLlamaCppManaged,
  GEMMA_PRESET_DEFAULTS,
  countLlmModels,
  findLlmModelLocation,
  inferContextWindowTokens,
  mergeLlmProviderModel,
  normalizeChatContainerSize,
  normalizeMonacoWorkspaceEditorSettings,
  optimizationPresetsForProvider,
  QWEN_PRESET_DEFAULTS,
  isPinnedLlmSourceId,
  isPinnedLmStudioProviderId,
  isPinnedLlamaCppLocalProviderId,
  isPinnedLlamaServerUrlProviderId,
} from '@shared/index';
import { ElectronService } from '../../../core/electron.service';
import { ThemedConfirmDialogService } from '../../../shared/themed-confirm-dialog/themed-confirm-dialog.service';
import { ThemedConfirmDialogComponent } from '../../../shared/themed-confirm-dialog/themed-confirm-dialog';
import { activeStreamWorkspaceSwitchPrompt, unsavedWorkspaceSwitchPrompt } from '../../../shared/themed-confirm-dialog/format-unsaved-workspace-detail';
import { customModelDeletePrompt } from '../../../shared/themed-confirm-dialog/format-delete-prompt';
import { DEFAULT_THEME_ID, THEMES, ThemeOption } from '../../layout/theme-selector/theme-selector';
import { FontControl } from '../../layout/font-control/font-control';
import { applyAppFontOverrides } from '../../shell/app-theme';
import { VOICE_OPTIONS } from '../../speech/speech-module/speech-module';
import { LucideAngularModule } from 'lucide-angular';

type SettingsTab = 'general' | 'models' | 'modelManager' | 'tools' | 'monaco' | 'audio' | 'workspaces';

type SettingsSubTabEntry = {
  id: string;
  label: string;
  description: string;
};

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

const MONACO_EDITOR_THEME_LABELS: Record<MonacoWorkspaceEditorThemeId, string> = {
  'clara-monaco': 'Clara (matches app)',
  vs: 'VS Light',
  'vs-dark': 'VS Dark',
  'hc-black': 'High contrast dark',
  'hc-light': 'High contrast light',
};

interface TalkAudioInputDevice {
  deviceId: string;
  label: string;
}

@Component({
  selector: 'app-settings',
  imports: [FormsModule, LucideAngularModule, DecimalPipe, FontControl, ThemedConfirmDialogComponent, NgxSpinnerComponent],
  templateUrl: './settings.html',
  styleUrl: './settings.css',
})
export class Settings implements OnInit, OnDestroy {
  private readonly ngxSpinner = inject(NgxSpinnerService);
  private readonly inj = inject(Injector);
  private destroyed = false;

  /** Shown in managed llama-server tips and placeholders (must match Electron substitution token). */
  protected readonly managedLlamaPortToken = '{{PORT}}';
  protected readonly closeSaving = signal(false);
  protected readonly closeSpinnerName = `settings-close-${Math.random().toString(36).slice(2, 10)}`;
  protected readonly planProgressSpinnerType = PLAN_PROGRESS_SPINNER_TYPE;
  protected readonly cacheDetectSpinnerName = `settings-cache-detect-${Math.random().toString(36).slice(2, 10)}`;
  protected readonly localModelsSpinnerName = `settings-local-models-${Math.random().toString(36).slice(2, 10)}`;
  protected readonly migratableModelsSpinnerName = `settings-migratable-models-${Math.random().toString(36).slice(2, 10)}`;
  protected readonly cacheDetectSpinnerType = CACHE_DETECT_SPINNER_TYPE;
  protected readonly modelManagerCacheLoading = signal(false);
  protected readonly modelManagerLocalLoading = signal(false);
  protected readonly modelManagerMigratableLoading = signal(false);
  /**
   * Default chat command for newly added managed ``llama-server`` sources (not the pinned local row).
   */
  private static readonly newManagedLlamacppChatCommand = DEFAULT_MANAGED_LLAMA_CHAT_RUN_COMMAND;
  protected readonly selectedSettingsTab = signal<SettingsTab>('models');
  protected readonly tabs: Array<{ id: SettingsTab; label: string; description: string }> = [
    {
      id: 'general',
      label: 'General',
      description: 'UI theme, chat font size, and other global preferences.',
    },
    {
      id: 'models',
      label: 'Models',
      description:
        'LM Studio, remote llama-server (LAN), and local managed llama-server are built in. Add sources for more managed instances. The highlighted source is used for chat.',
    },
    {
      id: 'modelManager',
      label: 'Model Manager',
      description: 'Local models, cache migration, and Hugging Face search.',
    },
    {
      id: 'tools',
      label: 'Tools',
      description: 'Workspace agent tool limits and edit modes (synced to the Python backend).',
    },
    {
      id: 'monaco',
      label: 'Editor',
      description: 'Monaco options for the in-app workspace file editor (color theme, font, minimap, wrap, cursor, and editing behavior).',
    },
    { id: 'audio', label: 'Audio', description: 'Transcription, talk-mode microphone, Kokoro assistant voice, speech speed, and end-of-speech timing.' },
    { id: 'workspaces', label: 'Workspaces', description: 'Attached folders and active project.' },
  ];
  /** Kokoro voice ids for {@link AudioTranscriptionConfig.ttsVoice} (same list as chat TTS). */
  protected readonly ttsVoiceChoices = VOICE_OPTIONS;
  protected readonly themes: ThemeOption[] = THEMES;
  protected readonly monacoEditorThemeSelectOptions = MONACO_WORKSPACE_EDITOR_THEME_IDS.map((id) => ({
    id,
    label: MONACO_EDITOR_THEME_LABELS[id],
  }));
  /** Curated App font choices (Settings → General → Chat appearance). */
  protected readonly uiFontFamilyOptions = UI_FONT_FAMILY_OPTIONS;
  /** Curated Code font choices (Settings → General → Chat appearance). */
  protected readonly codeFontFamilyOptions = CODE_FONT_FAMILY_OPTIONS;
  /** OS-installed fonts (from `list-system-fonts` IPC), shown under "System fonts" in both pickers. */
  protected readonly systemFonts = signal<SystemFontInfo[]>([]);
  protected readonly systemFontOptions = computed<FontFamilyOption[]>(() =>
    this.systemFonts().map((f) => ({
      label: f.monospace ? `${f.name} (monospace)` : f.name,
      stack: `${f.familyName}, ${f.monospace ? 'monospace' : 'sans-serif'}`,
    })),
  );
  protected readonly settingsSubTabCatalog: Partial<Record<SettingsTab, SettingsSubTabEntry[]>> = {
    general: [
      {
        id: 'themes',
        label: 'Theme',
        description: 'App-wide UI theme.',
      },
      {
        id: 'chat',
        label: 'Chat appearance',
        description:
          'App UI scale, chat font size, expanded chat width, app-wide UI font, and code font for message text.',
      },
    ],
    tools: [
      {
        id: 'editTools',
        label: 'Edit tools',
        description:
          'File-edit tool mode and workspace exposure when Editor mode is on in the chat toolbar.',
      },
      {
        id: 'limits',
        label: 'Read & search limits',
        description: 'Caps how much one read or search tool call can return.',
      },
      {
        id: 'compression',
        label: 'Context compression',
        description:
          'Shortens older tool result bodies in the LangGraph checkpoint when usage exceeds the trigger threshold.',
      },
      {
        id: 'encoding',
        label: 'Encoding & newlines',
        description:
          'Default encoding and newline style when the model omits them on read, search, and edit tools.',
      },
    ],
    monaco: [
      {
        id: 'theme',
        label: 'Color theme',
        description:
          'Monaco color theme for workspace files. Clara tracks the app code colors; VS and high-contrast themes are built-ins.',
      },
      {
        id: 'typography',
        label: 'Typography',
        description: 'Font size, line height, and optional font family. Leave family empty for the app monospace stack.',
      },
      {
        id: 'wrapMinimap',
        label: 'Wrap & minimap',
        description: 'Word wrap mode, wrap column, and minimap visibility and behavior.',
      },
      {
        id: 'display',
        label: 'Display',
        description: 'Scrolling, whitespace, line numbers, folding, and editor padding.',
      },
      {
        id: 'guides',
        label: 'Guides & indent',
        description: 'Indent and bracket guides, tab size, and space-vs-tab behavior.',
      },
      {
        id: 'cursor',
        label: 'Cursor',
        description: 'Cursor blink animation, shape, and width (0 = default).',
      },
      {
        id: 'editing',
        label: 'Editing',
        description: 'Formatting, auto-close pairs, and IntelliSense-style suggestions.',
      },
    ],
    audio: [
      {
        id: 'provider',
        label: 'Provider',
        description: 'Enable transcription or turn it off completely.',
      },
      {
        id: 'endpoint',
        label: 'Endpoint',
        description: 'OpenAI-compatible transcription base URL, model name, and API key.',
      },
      {
        id: 'capture',
        label: 'Voice capture',
        description: 'Talk-mode microphone and end-of-speech silence timing.',
      },
      {
        id: 'tts',
        label: 'Assistant voice',
        description: 'Kokoro (local) or OpenAI-compatible remote TTS for spoken assistant replies.',
      },
    ],
  };
  protected readonly selectedSubTabs = signal<Partial<Record<SettingsTab, string>>>({});
  protected readonly workspaces = signal<Workspace[]>([]);
  protected readonly currentWorkspace = signal<Workspace | null>(null);
  protected readonly themeId = signal(DEFAULT_THEME_ID);
  protected readonly llmProviders = signal<LlmProviderConfig[]>([]);
  protected readonly activeLlmModelId = signal('default-lmstudio');
  protected readonly selectedModelId = signal<string | null>(null);
  protected readonly audioProvider = signal<'openai' | 'disabled' | 'google'>('openai');
  protected readonly audioBaseUrl = signal('');
  protected readonly audioModel = signal('gpt-4o-mini-transcribe');
  protected readonly audioApiKey = signal('');
  protected readonly talkInputDeviceId = signal('default');
  protected readonly talkSilenceThresholdSeconds = signal(2);
  protected readonly talkAudioInputDevices = signal<TalkAudioInputDevice[]>([]);
  protected readonly talkAudioInputsLoadError = signal('');
  protected readonly chatFontSizeRem = signal(0.9);
  protected readonly chatContainerSize = signal<ChatContainerSize>(DEFAULT_CHAT_CONTAINER_SIZE);
  protected readonly chatContainerSizeOptions = CHAT_CONTAINER_SIZE_OPTIONS;
  protected readonly uiFontSizeRem = signal(UI_FONT_SIZE_REM_DEFAULT);
  /** App-wide UI font override (CSS font-family value); empty = theme default. */
  protected readonly uiFontFamily = signal('');
  /** Code font override (CSS font-family value); empty = theme default. Overrides Monaco's own fontFamily. */
  protected readonly codeFontFamily = signal('');
  protected readonly monacoWorkspaceEditor = signal<MonacoWorkspaceEditorSettings>(defaultMonacoWorkspaceEditorSettings());
  protected readonly ttsVoice = signal(DEFAULT_KOKORO_TTS_VOICE);
  protected readonly ttsSpeechSpeed = signal(TTS_SPEECH_SPEED_DEFAULT);
  protected readonly ttsProvider = signal<TtsProvider>(DEFAULT_TTS_PROVIDER);
  protected readonly ttsBaseUrl = signal(DEFAULT_OPENAI_TTS_BASE_URL);
  protected readonly ttsApiKey = signal('');
  protected readonly ttsDefaultInstructions = signal('');
  protected readonly editToolsMode = signal<'standard' | 'strict'>('standard');
  protected readonly maxFileReadLines = signal(400);
  protected readonly maxSearchResults = signal(40);
  protected readonly defaultWorkspaceEncoding = signal('utf-8');
  protected readonly defaultWorkspaceNewline = signal<'lf' | 'crlf' | 'preserve'>('lf');
  protected readonly allowStagingOverlayCommands = signal(false);
  protected readonly commandLineExplainStep = signal(false);
  protected readonly exposeAllWorkspaceFiles = signal(false);
  protected readonly allowWebAccess = signal(false);
  protected readonly searxngBaseUrl = signal('');
  protected readonly contextCompressionEnabled = signal(true);
  protected readonly contextCompressionTriggerRatio = signal(0.7);
  protected readonly contextCompressionTargetRatio = signal(0.55);
  protected readonly contextCompressionProtectTail = signal(24);
  protected readonly contextCompressionRecentToolChars = signal(2000);
  protected readonly contextCompressionOldToolChars = signal(400);
  protected readonly contextCompressionSystemReserve = signal(0.25);
  protected readonly modelManagerCustomDir = signal('');
  protected readonly modelManagerHfToken = signal('');
  protected readonly modelManagerCustomModels = signal<ModelManagerFileEntry[]>([]);
  protected readonly modelManagerCacheLocations = signal<ModelManagerCacheLocation[]>([]);
  protected readonly modelManagerCacheCandidates = signal<ModelManagerFileEntry[]>([]);
  protected readonly modelManagerHfQuery = signal('');
  protected readonly modelManagerHfResults = signal<HuggingFaceModelSearchItem[]>([]);
  protected readonly modelManagerHfPage = signal(0);
  protected readonly modelManagerHfHasMore = signal(false);
  protected readonly modelManagerHfTotalPages = signal(0);
  protected readonly modelManagerHfWindowStart = signal(0);
  protected readonly modelManagerHfPageSize = 10;
  protected readonly modelManagerHfPageWindowSize = 10;
  protected readonly modelManagerHfPageNumbers = computed(() => {
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
  protected readonly modelManagerStatus = signal('');
  protected readonly modelManagerBusy = signal(false);
  protected readonly modelManagerHfBusy = signal(false);
  protected readonly modelManagerMigratingPath = signal<string | null>(null);
  protected readonly modelManagerMigrateProgress = signal<ModelManagerMigrateProgressPayload | null>(null);
  private migrateProgressUnsub: (() => void) | null = null;
  protected readonly uiFontSizeRemMin = UI_FONT_SIZE_REM_MIN;
  protected readonly uiFontSizeRemMax = UI_FONT_SIZE_REM_MAX;
  protected readonly uiFontSizeRemDefault = UI_FONT_SIZE_REM_DEFAULT;
  protected readonly uiFontSizeRemStep = UI_FONT_SIZE_REM_STEP;
  protected readonly selectedLocation = computed(() => {
    const modelId = this.selectedModelId();
    if (!modelId) {
      return null;
    }
    return findLlmModelLocation(this.llmProviders(), modelId);
  });
  protected readonly selectedProvider = computed(() => this.selectedLocation()?.provider ?? null);
  protected readonly selectedModel = computed(() => this.selectedLocation()?.model ?? null);
  protected readonly selectedResolved = computed(() => {
    const loc = this.selectedLocation();
    if (!loc) {
      return null;
    }
    return mergeLlmProviderModel(loc.provider, loc.model);
  });
  /** True for the pinned remote llama-server row (URL + Connect), not managed run commands. */
  protected readonly isUrlOnlyLlamacpp = computed(() => {
    const p = this.selectedProvider();
    return !!p && p.provider === 'llamacpp' && isPinnedLlamaServerUrlProviderId(p.id);
  });
  /** Managed llama-server commands for the selected model (defaults when missing). */
  protected readonly selectedLlamaCppManaged = computed((): LlamaCppManaged => {
    const m = this.selectedModel();
    if (!m) {
      return defaultLlamaCppManaged();
    }
    return m.llamaCppManaged ?? defaultLlamaCppManaged();
  });
  protected readonly canDeleteSelectedProvider = computed(() => {
    const p = this.selectedProvider();
    if (!p || isPinnedLlmSourceId(p.id)) {
      return false;
    }
    return this.llmProviders().length > 1;
  });
  protected readonly settingsOverviewMeta = computed(() => {
    const parent = this.selectedSettingsTab();
    const subTabs = this.subTabsFor(parent);
    if (subTabs.length > 0) {
      const activeId = this.activeSubTabId(parent);
      const sub = subTabs.find((t) => t.id === activeId) ?? subTabs[0];
      return { label: sub.label, description: sub.description };
    }
    const tab = this.tabs.find((t) => t.id === parent) ?? this.tabs[0];
    return { label: tab.label, description: tab.description };
  });
  /** Pinned sources first: LM Studio, remote llama URL, local managed llama; remaining rows keep file order. */
  protected readonly sourcesOrdered = computed(() => {
    const list = this.llmProviders();
    const pinLm = list.find((p) => isPinnedLmStudioProviderId(p.id));
    const pinUrl = list.find((p) => isPinnedLlamaServerUrlProviderId(p.id));
    const pinLocal = list.find((p) => isPinnedLlamaCppLocalProviderId(p.id));
    const rest = list.filter((p) => !isPinnedLlmSourceId(p.id));
    const head: LlmProviderConfig[] = [];
    if (pinLm) {
      head.push(pinLm);
    }
    if (pinUrl) {
      head.push(pinUrl);
    }
    if (pinLocal) {
      head.push(pinLocal);
    }
    return [...head, ...rest];
  });
  protected readonly lmStudioInventory = signal<LmStudioModelCard[]>([]);
  protected readonly lmStudioInventoryError = signal<string | null>(null);
  protected readonly lmStudioListInFlight = signal(false);
  protected readonly lmStudioMainModelOptions = computed(() =>
    this.lmStudioInventory().filter((c) => !/embed/i.test(c.type)),
  );
  protected readonly lmStudioEmbeddingModelOptions = computed(() =>
    this.lmStudioInventory().filter((c) => /embed/i.test(c.type)),
  );
  protected readonly lmStudioLoadedCards = computed(() => this.lmStudioInventory().filter((c) => c.state === 'loaded'));
  protected readonly llamacppManagedModelIds = signal<string[]>([]);
  /** ``GET /v1/models`` from embeddings base URL when it differs from chat (URL-only llama.cpp). */
  protected readonly llamacppUrlEmbeddingModelIds = signal<string[]>([]);
  protected readonly llamacppModelsListError = signal<string | null>(null);
  protected readonly llamacppModelsListInFlight = signal(false);
  protected readonly llamacppUrlModelsSummary = computed(() => {
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
  private configSnapshot: AppConfig | null = null;
  /** True after any local edit; we persist only on close (or teardown) instead of debouncing every keystroke. */
  private settingsDirty = false;

  constructor(
    private electron: ElectronService,
    private themedConfirm: ThemedConfirmDialogService,
  ) {
    effect(() => {
      const saving = this.closeSaving();
      untracked(() => this.scheduleCloseSpinnerSync(saving));
    });
    effect(() => {
      const loading = this.modelManagerCacheLoading();
      untracked(() => this.scheduleNamedSpinnerSync(this.cacheDetectSpinnerName, loading));
    });
    effect(() => {
      const loading = this.modelManagerLocalLoading();
      untracked(() => this.scheduleNamedSpinnerSync(this.localModelsSpinnerName, loading));
    });
    effect(() => {
      const loading = this.modelManagerMigratableLoading();
      untracked(() => this.scheduleNamedSpinnerSync(this.migratableModelsSpinnerName, loading));
    });
  }

  async ngOnInit(): Promise<void> {
    const config = await this.electron.loadConfig();
    this.configSnapshot = structuredClone(config);
    this.syncFromConfig(config, true);

    this.subscription = this.electron.config$.subscribe((nextConfig) => {
      this.syncFromConfig(nextConfig, false);
    });

    void this.electron.listSystemFonts().then((fonts) => this.systemFonts.set(fonts));
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    void this.ngxSpinner.hide(this.closeSpinnerName);
    void this.ngxSpinner.hide(this.cacheDetectSpinnerName);
    void this.ngxSpinner.hide(this.localModelsSpinnerName);
    void this.ngxSpinner.hide(this.migratableModelsSpinnerName);
    this.migrateProgressUnsub?.();
    this.subscription?.unsubscribe();
    if (this.configSnapshot && this.settingsDirty) {
      void this.enqueuePersist();
    }
  }

  protected selectSettingsSubTab(tab: SettingsTab, id: string): void {
    this.selectedSubTabs.update((prev) => ({ ...prev, [tab]: id }));
  }

  protected subTabsFor(tab: SettingsTab): SettingsSubTabEntry[] {
    return this.settingsSubTabCatalog[tab] ?? [];
  }

  protected activeSubTabId(tab: SettingsTab): string {
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

  protected settingsSubTabSummary(tab: SettingsTab, id: string): string {
    switch (tab) {
      case 'general':
        if (id === 'themes') {
          const theme = this.themes.find((t) => t.id === this.themeId());
          return theme?.label.split(/\s+/)[0] ?? this.themeId();
        }
        if (id === 'chat') {
          const sizeLabel =
            CHAT_CONTAINER_SIZE_OPTIONS.find((opt) => opt.value === this.chatContainerSize())?.label ?? 'Standard';
          return `${sizeLabel} · UI ${this.uiFontSizeRem()} · chat ${this.chatFontSizeRem()}rem`;
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
        break;
      case 'monaco':
        return this.monacoSubTabSummary(id);
      case 'audio': {
        if (id === 'provider') {
          const p = this.audioProvider();
          if (p === 'disabled') return 'Disabled';
          if (p === 'google') return 'Google';
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

  protected selectTab(tab: SettingsTab): void {
    this.selectedSettingsTab.set(tab);
    if (tab === 'audio') {
      void this.refreshTalkAudioInputs();
    } else if (tab === 'modelManager') {
      void this.refreshModelManagerData();
    }
  }

  /** Double-clicking the top bar toggles maximize, matching the main window's title bar. */
  protected onTopBarDoubleClick(): void {
    this.electron.windowToggleMaximize();
  }

  protected async closeSettings(): Promise<void> {
    if (this.closeSaving()) {
      return;
    }
    this.closeSaving.set(true);
    try {
      await this.flushPersistForClose();
    } finally {
      this.closeSaving.set(false);
      this.electron.closeSettingsWindow();
    }
  }

  private scheduleCloseSpinnerSync(show: boolean): void {
    afterNextRender(
      () => {
        if (this.destroyed) {
          return;
        }
        if (show) {
          void this.ngxSpinner.show(this.closeSpinnerName, CLOSE_SAVE_SPINNER);
        } else {
          void this.ngxSpinner.hide(this.closeSpinnerName);
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

  private async flushPersistForClose(): Promise<void> {
    if (!this.configSnapshot || !this.settingsDirty) {
      return;
    }
    await this.enqueuePersist();
  }

  protected applyTheme(themeId: string): void {
    const theme = THEMES.find((item) => item.id === themeId) ?? THEMES[0];
    document.documentElement.className = theme.cssClass;
    document.documentElement.setAttribute('data-bs-theme', theme.bsTheme);
  }

  protected onThemeChange(themeId: string): void {
    this.themeId.set(themeId);
    this.applyTheme(themeId);
    this.markSettingsDirty();
  }

  protected async addWorkspace(): Promise<void> {
    const selected = await this.electron.openDirectoryDialog();
    if (!selected) {
      return;
    }

    const existing = this.workspaces().find((workspace) => workspace.path === selected);
    if (existing) {
      await this.selectWorkspace(existing.id);
      return;
    }

    const name = selected.split(/[\\/]/).pop() || 'New Workspace';
    await this.electron.addWorkspace(name, selected);
  }

  protected async removeWorkspace(id: string): Promise<void> {
    await this.electron.removeWorkspace(id);
  }

  protected async selectWorkspace(id: string | null): Promise<void> {
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

  protected selectSource(providerId: string): void {
    const p = this.llmProviders().find((x) => x.id === providerId);
    const first = p?.models[0];
    if (!first) {
      return;
    }
    this.selectedModelId.set(first.id);
    if (p.provider === 'lmstudio') {
      void this.refreshLmStudioInventory();
    } else {
      this.lmStudioInventory.set([]);
      this.lmStudioInventoryError.set(null);
    }
    if (p.provider === 'llamacpp') {
      if (isPinnedLlamaServerUrlProviderId(p.id)) {
        void this.refreshLlamacppUrlModels();
      } else {
        this.llamacppUrlEmbeddingModelIds.set([]);
        void this.refreshLlamacppManagedModels();
      }
    } else {
      this.llamacppManagedModelIds.set([]);
      this.llamacppUrlEmbeddingModelIds.set([]);
      this.llamacppModelsListError.set(null);
    }
  }

  protected activateSource(providerId: string): void {
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

  protected sourceIsSelected(provider: LlmProviderConfig): boolean {
    return this.selectedProvider()?.id === provider.id;
  }

  protected async refreshLlamacppManagedModels(): Promise<void> {
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

  protected async refreshLlamacppUrlModels(): Promise<void> {
    const p = this.selectedProvider();
    if (!p || p.provider !== 'llamacpp') {
      return;
    }
    this.llamacppModelsListInFlight.set(true);
    this.llamacppModelsListError.set(null);
    try {
      const chatRes = await this.electron.llamacppOpenAiListModels({ baseUrl: p.baseUrl, apiKey: p.apiKey || '' });
      if (!chatRes.ok) {
        this.llamacppManagedModelIds.set([]);
        this.llamacppUrlEmbeddingModelIds.set([]);
        this.llamacppModelsListError.set(chatRes.error);
        return;
      }
      this.llamacppManagedModelIds.set(chatRes.models);

      const embBase = (p.embeddingsBaseUrl ?? '').trim();
      if (!embBase || openAiV1BasesEquivalent(p.baseUrl, embBase)) {
        this.llamacppUrlEmbeddingModelIds.set([...chatRes.models]);
        return;
      }

      const embRes = await this.electron.llamacppOpenAiListModels({ baseUrl: embBase, apiKey: p.apiKey || '' });
      if (!embRes.ok) {
        this.llamacppUrlEmbeddingModelIds.set([]);
        this.llamacppModelsListError.set(`Chat OK; embeddings server: ${embRes.error}`);
        return;
      }
      this.llamacppUrlEmbeddingModelIds.set(embRes.models);
    } catch (e) {
      this.llamacppManagedModelIds.set([]);
      this.llamacppUrlEmbeddingModelIds.set([]);
      this.llamacppModelsListError.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.llamacppModelsListInFlight.set(false);
    }
  }

  protected isPinnedSource(providerId: string): boolean {
    return isPinnedLlmSourceId(providerId);
  }

  protected async refreshLmStudioInventory(): Promise<void> {
    const p = this.selectedProvider();
    if (!p || p.provider !== 'lmstudio') {
      return;
    }
    this.lmStudioListInFlight.set(true);
    this.lmStudioInventoryError.set(null);
    const res = await this.electron.lmStudioListModels({ baseUrl: p.baseUrl, apiKey: p.apiKey });
    this.lmStudioListInFlight.set(false);
    if (res.ok) {
      this.lmStudioInventory.set(res.models);
    } else {
      this.lmStudioInventory.set([]);
      this.lmStudioInventoryError.set(res.error);
    }
  }

  protected lmStudioLoadDisabled(): boolean {
    const p = this.selectedProvider();
    const m = this.selectedModel();
    if (!p || p.provider !== 'lmstudio' || !m) {
      return true;
    }
    const main = (m.model || '').trim();
    const emb = (p.embeddingsModel || '').trim();
    const inv = this.lmStudioInventory();
    const needLoad = (id: string) => {
      const c = inv.find((x) => x.id === id);
      return !c || c.state !== 'loaded';
    };
    const wantsMain = !!main && needLoad(main);
    const wantsEmb = !!emb && needLoad(emb);
    return !wantsMain && !wantsEmb;
  }

  protected async loadLmStudioSelectedModels(): Promise<void> {
    const p = this.selectedProvider();
    const m = this.selectedModel();
    if (!p || p.provider !== 'lmstudio' || !m) {
      return;
    }
    const keys: string[] = [];
    const main = (m.model || '').trim();
    const emb = (p.embeddingsModel || '').trim();
    if (main) {
      keys.push(main);
    }
    if (emb && emb !== main) {
      keys.push(emb);
    }
    for (const k of keys) {
      await this.electron.lmStudioLoadModel({ baseUrl: p.baseUrl, model: k, apiKey: p.apiKey });
    }
    await this.refreshLmStudioInventory();
  }

  protected async unloadLmStudioCard(card: LmStudioModelCard): Promise<void> {
    const p = this.selectedProvider();
    if (!p || p.provider !== 'lmstudio' || !card.instanceId) {
      return;
    }
    await this.electron.lmStudioUnloadModel({
      baseUrl: p.baseUrl,
      instanceId: card.instanceId,
      apiKey: p.apiKey,
    });
    await this.refreshLmStudioInventory();
  }

  protected addProvider(): void {
    const idx = this.llmProviders().filter((p) => !isPinnedLlmSourceId(p.id)).length;
    const nextProvider = this.buildNewLlamacppProvider(idx + 1);
    this.llmProviders.update((p) => [...p, nextProvider]);
    const firstId = nextProvider.models[0]?.id ?? null;
    this.selectedModelId.set(firstId);
    if (nextProvider.provider === 'llamacpp' && firstId) {
      void this.refreshLlamacppManagedModels();
    }
    this.markSettingsDirty();
  }

  protected removeProvider(providerId: string): void {
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

  protected removeSelectedProvider(): void {
    const p = this.selectedProvider();
    if (!p) {
      return;
    }
    this.removeProvider(p.id);
  }

  protected removeModel(providerId: string, modelId: string): void {
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

  protected updateSelectedModel(changes: Partial<LlmModelProfile>): void {
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

  protected updateSelectedProvider(
    changes: Partial<
      Pick<LlmProviderConfig, 'name' | 'provider' | 'baseUrl' | 'apiKey' | 'embeddingsModel' | 'embeddingsBaseUrl'>
    >,
  ): void {
    const loc = this.selectedLocation();
    if (!loc) {
      return;
    }
    this.applyProviderPatch(loc.provider.id, changes);
    this.markSettingsDirty();
  }

  protected onProviderKindChange(provider: LlmProviderConfig['provider']): void {
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

  protected onModelApiIdChange(model: string): void {
    const loc = this.selectedLocation();
    if (!loc) {
      return;
    }
    this.applyLlmModelPatch(loc.model.id, {
      model,
      name: model,
      contextWindowTokens: inferContextWindowTokens(model, loc.provider.provider),
    });
    this.markSettingsDirty();
  }

  protected onTemperatureChange(raw: string | number): void {
    const n = typeof raw === 'number' ? raw : Number.parseFloat(raw);
    if (Number.isNaN(n)) {
      return;
    }
    const clamped = Math.min(1, Math.max(0, n));
    this.updateSelectedModel({ temperature: clamped });
  }

  protected presetsFor(provider: LlmProviderConfig['provider']) {
    return optimizationPresetsForProvider(provider);
  }

  protected providerKindLabel(kind: LlmProviderConfig['provider']): string {
    if (kind === 'lmstudio') {
      return 'LM Studio';
    }
    if (kind === 'llamacpp') {
      return 'llama.cpp';
    }
    return 'OpenAI';
  }

  protected presetDescription(connection: LlmConnectionConfig): string {
    return (
      optimizationPresetsForProvider(connection.provider).find((p) => p.id === connection.optimizationPreset)
        ?.description ?? ''
    );
  }

  protected formatTemperature(value: number): string {
    return Number.isFinite(value) ? value.toFixed(2) : '0.00';
  }

  protected onOptimizationPresetChange(value: string): void {
    const preset: LlmOptimizationPreset =
      value === 'qwen'
        ? 'qwen'
        : value === 'capable'
          ? 'capable'
          : value === 'gemma'
            ? 'gemma'
            : 'generic';
    const model = this.selectedModel();
    if (!model) {
      return;
    }
    if (preset === 'qwen') {
      const cap = QWEN_PRESET_DEFAULTS.temperatureCap;
      const nextTemp = Math.min(model.temperature, cap);
      this.applyLlmModelPatch(model.id, {
        optimizationPreset: 'qwen',
        parallelToolCalls: QWEN_PRESET_DEFAULTS.parallelToolCalls,
        maxOutputTokens: QWEN_PRESET_DEFAULTS.maxOutputTokens,
        temperature: nextTemp,
      });
    } else if (preset === 'gemma') {
      const g = GEMMA_PRESET_DEFAULTS;
      this.applyLlmModelPatch(model.id, {
        optimizationPreset: 'gemma',
        parallelToolCalls: g.parallelToolCalls,
        maxOutputTokens: g.maxOutputTokens,
        temperature: g.temperature,
        samplingPreset: g.samplingPreset,
        thinkingMode: g.thinkingMode,
        architectureHint: g.architectureHint,
        topP: g.topP,
        topK: g.topK,
      });
    } else if (preset === 'capable') {
      this.applyLlmModelPatch(model.id, {
        optimizationPreset: 'capable',
        parallelToolCalls: CAPABLE_PRESET_DEFAULTS.parallelToolCalls,
      });
    } else {
      this.applyLlmModelPatch(model.id, { optimizationPreset: 'generic' });
    }
    this.markSettingsDirty();
  }

  protected onOptionalTopPChange(raw: number | string | null): void {
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

  protected onOptionalTopKChange(raw: number | string | null): void {
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

  protected onOptionalMinPChange(raw: number | string | null): void {
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

  protected onOptionalPresencePenaltyChange(raw: number | string | null): void {
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

  protected onOptionalRepeatPenaltyChange(raw: number | string | null): void {
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

  protected onMaxOutputTokensChange(raw: string | number): void {
    const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
    if (Number.isNaN(n)) {
      return;
    }
    const clamped = Math.min(200_000, Math.max(0, n));
    this.updateSelectedModel({ maxOutputTokens: clamped });
  }

  protected onContextWindowTokensChange(raw: string | number): void {
    const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
    if (Number.isNaN(n)) {
      return;
    }
    const clamped = Math.min(10_000_000, Math.max(1_024, n));
    this.updateSelectedModel({ contextWindowTokens: clamped });
  }

  protected onPlanRetryAttemptsCountChange(raw: string | number): void {
    const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
    if (Number.isNaN(n)) {
      return;
    }
    const clamped = Math.min(20, Math.max(0, n));
    this.updateSelectedModel({ planRetryAttemptsCount: clamped });
  }

  protected patchLlamaCppManaged(patch: Partial<LlamaCppManaged>): void {
    const m = this.selectedModel();
    if (!m) {
      return;
    }
    const base = m.llamaCppManaged ?? defaultLlamaCppManaged();
    this.updateSelectedModel({
      llamaCppManaged: { ...base, ...patch },
    });
  }

  protected formatModelBytes(sizeBytes: number): string {
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

  protected formatModelDate(modifiedMs: number): string {
    if (!Number.isFinite(modifiedMs)) {
      return '';
    }
    return new Date(modifiedMs).toLocaleString();
  }

  protected updateModelManagerConfig(
    changes: Partial<{
      customModelsDir: string;
      huggingFaceToken: string;
      detectedCaches: ModelManagerCacheLocation[];
    }>,
  ): void {
    if (changes.customModelsDir !== undefined) {
      this.modelManagerCustomDir.set(changes.customModelsDir);
    }
    if (changes.huggingFaceToken !== undefined) {
      this.modelManagerHfToken.set(changes.huggingFaceToken);
    }
    if (changes.detectedCaches !== undefined) {
      this.modelManagerCacheLocations.set(changes.detectedCaches);
    }
    this.markSettingsDirty();
  }

  protected async pickModelManagerCustomDir(): Promise<void> {
    const selected = await this.electron.modelManagerPickCustomDir();
    if (!selected) {
      return;
    }
    this.updateModelManagerConfig({ customModelsDir: selected });
    await this.refreshModelManagerData({ clearStatus: false });
    this.modelManagerStatus.set('Custom model directory updated.');
  }

  protected async refreshModelManagerData(options?: {
    clearStatus?: boolean;
    /** When true, re-run filesystem cache-root detection and persist results. */
    forceDetectCaches?: boolean;
  }): Promise<void> {
    if (options?.clearStatus !== false) {
      this.modelManagerStatus.set('');
    }
    const needDetect =
      options?.forceDetectCaches === true || this.modelManagerCacheLocations().length === 0;

    const refreshCacheSide = async (): Promise<void> => {
      if (needDetect) {
        // Show cache spinner before detect IPC so the host can mount/paint.
        this.modelManagerCacheLoading.set(true);
        const cacheLoadStartedAt = Date.now();
        try {
          await this.refreshDetectedCaches({ persist: true });
        } finally {
          const elapsed = Date.now() - cacheLoadStartedAt;
          if (elapsed < 350) {
            await new Promise<void>((resolve) => window.setTimeout(resolve, 350 - elapsed));
          }
          this.modelManagerCacheLoading.set(false);
        }
      }
      await this.refreshCacheCandidates();
    };

    await Promise.all([this.refreshCustomModelCards(), refreshCacheSide()]);
  }

  protected async refreshCustomModelCards(): Promise<void> {
    const dir = this.modelManagerCustomDir().trim();
    if (!dir) {
      this.modelManagerCustomModels.set([]);
      return;
    }
    this.modelManagerLocalLoading.set(true);
    const startedAt = Date.now();
    try {
      const res = await this.electron.modelManagerListCustomModels({ customDir: dir });
      if (res.ok) {
        this.modelManagerCustomModels.set(res.models);
        if (res.directoryMissing) {
          this.modelManagerStatus.set(
            `Custom model directory does not exist (${res.resolvedDir ?? dir}). Create the folder or fix the path.`,
          );
        }
      } else {
        this.modelManagerCustomModels.set([]);
        this.modelManagerStatus.set(res.error);
      }
    } finally {
      const elapsed = Date.now() - startedAt;
      if (elapsed < 350) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 350 - elapsed));
      }
      this.modelManagerLocalLoading.set(false);
    }
  }

  protected async refreshDetectedCaches(options?: { persist?: boolean }): Promise<void> {
    const res = await this.electron.modelManagerDetectCaches();
    if (!res.ok) {
      this.modelManagerStatus.set(res.error);
      if (options?.persist) {
        this.updateModelManagerConfig({ detectedCaches: [] });
      } else {
        this.modelManagerCacheLocations.set([]);
      }
      return;
    }
    if (options?.persist) {
      this.updateModelManagerConfig({ detectedCaches: res.caches });
    } else {
      this.modelManagerCacheLocations.set(res.caches);
    }
  }

  protected async refreshCacheCandidates(): Promise<void> {
    const existingCaches = this.modelManagerCacheLocations()
      .filter((c) => c.exists)
      .map((c) => c.path);
    if (existingCaches.length === 0) {
      this.modelManagerCacheCandidates.set([]);
      return;
    }
    this.modelManagerMigratableLoading.set(true);
    const startedAt = Date.now();
    try {
      const res = await this.electron.modelManagerListCacheCandidates({ cachePaths: existingCaches });
      if (!res.ok) {
        this.modelManagerStatus.set(res.error);
        this.modelManagerCacheCandidates.set([]);
        return;
      }
      this.modelManagerCacheCandidates.set(res.models);
    } finally {
      const elapsed = Date.now() - startedAt;
      if (elapsed < 350) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 350 - elapsed));
      }
      this.modelManagerMigratableLoading.set(false);
    }
  }

  protected isCacheModelMigrating(model: ModelManagerFileEntry): boolean {
    const active = this.modelManagerMigratingPath();
    return !!active && active === model.absolutePath;
  }

  protected modelManagerMigratePercent(): number {
    const p = this.modelManagerMigrateProgress();
    if (!p || p.bytesTotal <= 0) {
      return 0;
    }
    return Math.min(100, Math.round((Math.min(p.bytesDone, p.bytesTotal) / p.bytesTotal) * 100));
  }

  protected modelManagerMigrateIndeterminate(): boolean {
    const p = this.modelManagerMigrateProgress();
    return !p || p.phase === 'scanning';
  }

  protected modelManagerMigratePhaseLabel(): string {
    const p = this.modelManagerMigrateProgress();
    switch (p?.phase) {
      case 'scanning':
        return 'Scanning files…';
      case 'copying':
        return `Copying… ${this.modelManagerMigratePercent()}%`;
      case 'finishing':
        return 'Finishing…';
      case 'done':
        return 'Done';
      default:
        return 'Preparing…';
    }
  }

  protected async migrateCacheModel(model: ModelManagerFileEntry): Promise<void> {
    const customDir = this.modelManagerCustomDir().trim();
    if (!customDir) {
      this.modelManagerStatus.set('Set a custom model directory first.');
      return;
    }
    const mode = await this.electron.modelManagerChooseMigrateMode({
      title: `Migrate "${model.fileName}"?`,
      detail:
        model.entryKind === 'hubRepo'
          ? 'Copies or moves the entire Hugging Face hub folder (blobs, refs, snapshots) into your custom directory.'
          : 'Copies or moves this GGUF/GGML file into your custom directory.',
    });
    if (!mode) {
      return;
    }
    this.modelManagerMigratingPath.set(model.absolutePath);
    this.modelManagerMigrateProgress.set({ bytesDone: 0, bytesTotal: 1, phase: 'scanning' });
    this.migrateProgressUnsub?.();
    this.migrateProgressUnsub = this.electron.subscribeModelManagerMigrateProgress((p) => {
      this.modelManagerMigrateProgress.set(p);
    });
    this.modelManagerBusy.set(true);
    try {
      const res = await this.electron.modelManagerMigrateModel({
        sourcePath: model.absolutePath,
        customDir,
        mode,
        suggestedFileName: model.suggestedFileName || model.fileName,
        entryKind: model.entryKind === 'hubRepo' ? 'hubRepo' : undefined,
      });
      if (!res.ok) {
        this.modelManagerStatus.set(res.error);
        return;
      }
      await this.refreshModelManagerData({ clearStatus: false });
      this.modelManagerStatus.set(`${model.fileName} migrated via ${mode}.`);
    } finally {
      this.migrateProgressUnsub?.();
      this.migrateProgressUnsub = null;
      this.modelManagerMigratingPath.set(null);
      this.modelManagerMigrateProgress.set(null);
      this.modelManagerBusy.set(false);
    }
  }

  protected async renameCustomModel(model: ModelManagerFileEntry): Promise<void> {
    const customDir = this.modelManagerCustomDir().trim();
    if (!customDir) {
      return;
    }
    const nextName = window.prompt('Rename model file:', model.fileName);
    if (!nextName || nextName.trim() === model.fileName) {
      return;
    }
    this.modelManagerBusy.set(true);
    try {
      const res = await this.electron.modelManagerRenameModel({
        customDir,
        modelPath: model.absolutePath,
        newFileName: nextName.trim(),
      });
      if (!res.ok) {
        this.modelManagerStatus.set(res.error);
        return;
      }
      this.modelManagerStatus.set(`Renamed to ${res.model?.fileName ?? nextName.trim()}.`);
      await this.refreshCustomModelCards();
    } finally {
      this.modelManagerBusy.set(false);
    }
  }

  protected async deleteCustomModel(model: ModelManagerFileEntry): Promise<void> {
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
      await this.refreshCustomModelCards();
    } finally {
      this.modelManagerBusy.set(false);
    }
  }

  protected async searchHuggingFaceModels(page = 0): Promise<void> {
    const query = this.modelManagerHfQuery().trim();
    const nextPage = Math.max(0, Math.floor(page));
    if (!query) {
      this.modelManagerHfResults.set([]);
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
      });
      if (!res.ok) {
        this.modelManagerStatus.set(res.error);
        this.modelManagerHfResults.set([]);
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
        this.modelManagerHfResults.set([]);
        this.modelManagerHfPage.set(lastPage);
        return;
      }

      this.modelManagerHfResults.set(res.models);
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

  protected searchHuggingFaceModelsPrevPage(): void {
    const page = this.modelManagerHfPage();
    if (page <= 0 || this.modelManagerHfBusy()) {
      return;
    }
    const prev = page - 1;
    this.prepareHfPageWindowForNavigation(prev);
    void this.searchHuggingFaceModels(prev);
  }

  protected searchHuggingFaceModelsNextPage(): void {
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

  protected searchHuggingFaceModelsGotoPage(page: number): void {
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

  protected onModelManagerHfQueryChange(value: string): void {
    this.modelManagerHfQuery.set(value);
  }

  protected updateAudioSettings(changes: Partial<AudioTranscriptionConfig>): void {
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
      this.audioApiKey.set(changes.apiKey);
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
      this.ttsApiKey.set(typeof changes.ttsApiKey === 'string' ? changes.ttsApiKey : '');
    }
    if (changes.ttsDefaultInstructions !== undefined) {
      this.ttsDefaultInstructions.set(
        typeof changes.ttsDefaultInstructions === 'string' ? changes.ttsDefaultInstructions : '',
      );
    }
    this.markSettingsDirty();
  }

  protected onChatFontSizeRemChange(rem: number): void {
    const n = typeof rem === 'number' && !Number.isNaN(rem) ? rem : 0.9;
    const clamped = Math.min(1.6, Math.max(0.6, +n.toFixed(1)));
    this.chatFontSizeRem.set(clamped);
    this.markSettingsDirty();
  }

  protected onChatContainerSizeChange(size: ChatContainerSize): void {
    this.chatContainerSize.set(normalizeChatContainerSize(size));
    this.markSettingsDirty();
  }

  protected onUiFontSizeRemChange(rem: number): void {
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
  protected onUiFontFamilyChange(stack: string): void {
    this.uiFontFamily.set(stack ?? '');
    applyAppFontOverrides({
      uiFontSizeRem: this.uiFontSizeRem(),
      uiFontFamily: this.uiFontFamily(),
      codeFontFamily: this.codeFontFamily(),
    });
    this.markSettingsDirty();
  }

  /** Code font: rendered markdown code blocks + overrides the Monaco editor's own fontFamily. */
  protected onCodeFontFamilyChange(stack: string): void {
    this.codeFontFamily.set(stack ?? '');
    applyAppFontOverrides({
      uiFontSizeRem: this.uiFontSizeRem(),
      uiFontFamily: this.uiFontFamily(),
      codeFontFamily: this.codeFontFamily(),
    });
    this.markSettingsDirty();
  }

  protected onTalkInputDeviceIdChange(deviceId: string): void {
    this.updateAudioSettings({ talkInputDeviceId: deviceId || 'default' });
  }

  protected decreaseTalkSilenceThreshold(): void {
    const next = Math.max(
      TALK_SILENCE_THRESHOLD_MIN,
      +(this.talkSilenceThresholdSeconds() - TALK_SILENCE_THRESHOLD_STEP).toFixed(1),
    );
    this.updateAudioSettings({ talkSilenceThresholdSeconds: next });
  }

  protected readonly ttsSpeechSpeedMin = TTS_SPEECH_SPEED_MIN;
  protected readonly ttsSpeechSpeedMax = TTS_SPEECH_SPEED_MAX;
  protected readonly ttsSpeechSpeedStep = 0.05;

  protected onTtsSpeechSpeedInput(value: number): void {
    this.updateAudioSettings({ ttsSpeechSpeed: clampTtsSpeechSpeed(value) });
  }

  protected increaseTalkSilenceThreshold(): void {
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

  protected updateWorkspaceTools(changes: Partial<WorkspaceToolsConfig>): void {
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
    this.markSettingsDirty();
  }

  protected onEditToolsModeChange(mode: 'standard' | 'strict'): void {
    this.editToolsMode.set(mode);
    this.markSettingsDirty();
  }

  protected onMaxFileReadLinesChange(raw: string | number): void {
    const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
    if (Number.isNaN(n)) {
      return;
    }
    const clamped = Math.min(2000, Math.max(50, n));
    this.maxFileReadLines.set(clamped);
    this.markSettingsDirty();
  }

  protected onMaxSearchResultsChange(raw: string | number): void {
    const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
    if (Number.isNaN(n)) {
      return;
    }
    const clamped = Math.min(200, Math.max(1, n));
    this.maxSearchResults.set(clamped);
    this.markSettingsDirty();
  }

  protected onDefaultWorkspaceEncodingChange(value: string): void {
    const v = (value || 'utf-8').trim() || 'utf-8';
    this.defaultWorkspaceEncoding.set(v);
    this.markSettingsDirty();
  }

  protected onDefaultWorkspaceNewlineChange(value: string): void {
    const v = value === 'crlf' || value === 'preserve' ? value : 'lf';
    this.defaultWorkspaceNewline.set(v);
    this.markSettingsDirty();
  }

  protected onAllowStagingOverlayCommandsChange(enabled: boolean): void {
    this.allowStagingOverlayCommands.set(!!enabled);
    this.markSettingsDirty();
  }

  protected onCommandLineExplainStepChange(enabled: boolean): void {
    this.commandLineExplainStep.set(!!enabled);
    this.markSettingsDirty();
  }

  protected onExposeAllWorkspaceFilesChange(enabled: boolean): void {
    this.exposeAllWorkspaceFiles.set(!!enabled);
    this.markSettingsDirty();
  }

  protected onAllowWebAccessChange(enabled: boolean): void {
    this.allowWebAccess.set(!!enabled);
    this.markSettingsDirty();
  }

  protected onSearxngBaseUrlChange(value: string): void {
    this.searxngBaseUrl.set((value || '').trim());
    this.markSettingsDirty();
  }

  protected updateContextCompression(changes: Partial<ContextCompressionConfig>): void {
    if (changes.enabled !== undefined) {
      this.contextCompressionEnabled.set(!!changes.enabled);
    }
    if (changes.triggerRatio !== undefined) {
      this.contextCompressionTriggerRatio.set(changes.triggerRatio);
    }
    if (changes.targetRatio !== undefined) {
      this.contextCompressionTargetRatio.set(changes.targetRatio);
    }
    if (changes.protectTailMessages !== undefined) {
      this.contextCompressionProtectTail.set(changes.protectTailMessages);
    }
    if (changes.recentToolBodyMaxChars !== undefined) {
      this.contextCompressionRecentToolChars.set(changes.recentToolBodyMaxChars);
    }
    if (changes.oldToolBodyMaxChars !== undefined) {
      this.contextCompressionOldToolChars.set(changes.oldToolBodyMaxChars);
    }
    if (changes.systemReserveRatio !== undefined) {
      this.contextCompressionSystemReserve.set(changes.systemReserveRatio);
    }
    this.markSettingsDirty();
  }

  protected onContextCompressionEnabledChange(enabled: boolean): void {
    this.updateContextCompression({ enabled: !!enabled });
  }

  protected onContextCompressionTriggerRatioChange(raw: string | number): void {
    const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
    if (Number.isNaN(n)) return;
    const clamped = Math.min(0.95, Math.max(0.5, n));
    this.contextCompressionTriggerRatio.set(clamped);
    if (this.contextCompressionTargetRatio() > clamped) {
      this.contextCompressionTargetRatio.set(Math.min(clamped, 0.55));
    }
    this.markSettingsDirty();
  }

  protected onContextCompressionTargetRatioChange(raw: string | number): void {
    const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
    if (Number.isNaN(n)) return;
    const maxTarget = this.contextCompressionTriggerRatio();
    const clamped = Math.min(maxTarget, Math.max(0.4, Math.min(0.9, n)));
    this.contextCompressionTargetRatio.set(clamped);
    this.markSettingsDirty();
  }

  protected onContextCompressionProtectTailChange(raw: string | number): void {
    const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
    if (Number.isNaN(n)) return;
    this.contextCompressionProtectTail.set(Math.min(100, Math.max(8, n)));
    this.markSettingsDirty();
  }

  protected onContextCompressionRecentToolCharsChange(raw: string | number): void {
    const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
    if (Number.isNaN(n)) return;
    this.contextCompressionRecentToolChars.set(Math.min(20_000, Math.max(200, n)));
    this.markSettingsDirty();
  }

  protected onContextCompressionOldToolCharsChange(raw: string | number): void {
    const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
    if (Number.isNaN(n)) return;
    this.contextCompressionOldToolChars.set(Math.min(10_000, Math.max(100, n)));
    this.markSettingsDirty();
  }

  protected onContextCompressionSystemReserveChange(raw: string | number): void {
    const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
    if (Number.isNaN(n)) return;
    this.contextCompressionSystemReserve.set(Math.min(0.5, Math.max(0.1, n)));
    this.markSettingsDirty();
  }

  protected patchMonaco(patch: Partial<MonacoWorkspaceEditorSettings>): void {
    const merged = { ...this.monacoWorkspaceEditor(), ...patch };
    this.monacoWorkspaceEditor.set(normalizeMonacoWorkspaceEditorSettings(merged).settings);
    this.markSettingsDirty();
  }

  protected monacoEditorThemeLabel(id: MonacoWorkspaceEditorThemeId): string {
    return MONACO_EDITOR_THEME_LABELS[id];
  }

  protected monacoSubTabSummary(id: string): string {
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

  protected monacoEditorThemeShortLabel(id: MonacoWorkspaceEditorThemeId): string {
    switch (id) {
      case 'clara-monaco':
        return 'Clara';
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

  protected parseMonacoFloat(raw: string | number, fallback: number): number {
    const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
    return Number.isNaN(n) ? fallback : n;
  }

  protected parseMonacoInt(raw: string | number, fallback: number): number {
    const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
    return Number.isNaN(n) ? fallback : n;
  }

  protected onAudioProviderChange(provider: 'openai' | 'disabled' | 'google'): void {
    if (provider === 'disabled') {
      this.audioProvider.set('disabled');
      this.markSettingsDirty();
      return;
    }

    if (provider === 'google') {
      this.audioProvider.set('google');
      this.audioBaseUrl.set('');
      this.audioModel.set('google-web-speech');
      this.audioApiKey.set('');
      this.markSettingsDirty();
      return;
    }

    this.audioProvider.set('openai');
    this.audioBaseUrl.set(this.audioBaseUrl() || '');
    this.audioModel.set(this.audioModel() || 'gpt-4o-mini-transcribe');
    this.audioApiKey.set(this.audioApiKey());
    this.markSettingsDirty();
  }

  protected sourceIsActive(provider: LlmProviderConfig): boolean {
    const activeId = this.activeLlmModelId();
    return provider.models.some((m) => m.id === activeId);
  }

  protected trackProvider(_index: number, provider: LlmProviderConfig): string {
    return provider.id;
  }

  protected trackWorkspace(_index: number, workspace: Workspace): string {
    return workspace.id;
  }

  private buildNewModel(index: number, providerKind: LlmProviderConfig['provider']): LlmModelProfile {
    const apiModel = providerKind === 'lmstudio' || providerKind === 'llamacpp' ? 'local-model' : 'gpt-4o-mini';
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
      parallelToolCalls: false,
      optimizationPreset: 'generic',
      maxOutputTokens: 0,
      planRetryAttemptsCount: 2,
    };
    if (providerKind === 'llamacpp') {
      base.llamaCppManaged = {
        ...defaultLlamaCppManaged(),
        chatRunCommand: Settings.newManagedLlamacppChatCommand,
      };
    }
    return base;
  }

  private buildNewLlamacppProvider(index: number): LlmProviderConfig {
    const defaults = this.getProviderDefaults('llamacpp');
    const firstModel = this.buildNewModel(1, 'llamacpp');
    return {
      id: crypto.randomUUID(),
      name: `Llama Server ${index}`,
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
        apiKey: 'lm-studio',
      };
    }
    if (provider === 'llamacpp') {
      return {
        baseUrl: 'http://127.0.0.1:8080/v1',
        apiKey: '',
      };
    }

    return {
      baseUrl: '',
      apiKey: '',
    };
  }

  private markSettingsDirty(): void {
    this.settingsDirty = true;
  }

  private async enqueuePersist(): Promise<void> {
    const next = this.buildConfigForPersist();
    const saved = await this.electron.saveConfig(next);
    this.configSnapshot = structuredClone(saved);
    this.settingsDirty = false;
    this.syncFromConfig(saved, true);
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
      uiFontSizeRem: this.uiFontSizeRem(),
      uiFontFamily: this.uiFontFamily(),
      codeFontFamily: this.codeFontFamily(),
      workspaces: this.workspaces(),
      currentWorkspaceId: this.currentWorkspace()?.id ?? base.currentWorkspaceId,
      themeId: this.themeId(),
      activeLlmModelId: this.activeLlmModelId(),
      llmProviders: structuredClone(this.llmProviders()).map((p) =>
        isPinnedLmStudioProviderId(p.id)
          ? { ...p, provider: 'lmstudio', apiKey: (p.apiKey && p.apiKey.trim()) || 'lm-studio' }
          : p,
      ),
      audioTranscription: {
        provider: this.audioProvider(),
        baseUrl: this.audioBaseUrl(),
        model: this.audioModel(),
        apiKey: this.audioApiKey(),
        talkInputDeviceId: this.talkInputDeviceId(),
        talkSilenceThresholdSeconds: this.talkSilenceThresholdSeconds(),
        ttsVoice: this.ttsVoice(),
        ttsSpeechSpeed: this.ttsSpeechSpeed(),
        ttsProvider: this.ttsProvider(),
        ttsBaseUrl: this.ttsBaseUrl(),
        ttsApiKey: this.ttsApiKey(),
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
      },
      contextCompression: {
        enabled: this.contextCompressionEnabled(),
        triggerRatio: this.contextCompressionTriggerRatio(),
        targetRatio: this.contextCompressionTargetRatio(),
        protectTailMessages: this.contextCompressionProtectTail(),
        recentToolBodyMaxChars: this.contextCompressionRecentToolChars(),
        oldToolBodyMaxChars: this.contextCompressionOldToolChars(),
        systemReserveRatio: this.contextCompressionSystemReserve(),
      },
      modelManager: {
        customModelsDir: this.modelManagerCustomDir(),
        huggingFaceToken: this.modelManagerHfToken(),
        detectedCaches: this.modelManagerCacheLocations().map((cache) => ({ ...cache })),
      },
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
      Pick<LlmProviderConfig, 'name' | 'provider' | 'baseUrl' | 'apiKey' | 'embeddingsModel' | 'embeddingsBaseUrl'>
    >,
  ): void {
    this.llmProviders.update((providers) =>
      providers.map((p) => (p.id === providerId ? { ...p, ...changes } : p)),
    );
  }

  private syncFromConfig(config: AppConfig, forceFull: boolean): void {
    const blockEditableHydration = !forceFull && this.settingsDirty;
    if (blockEditableHydration) {
      this.workspaces.set(config.workspaces);
      const currentWorkspace =
        config.workspaces.find((workspace) => workspace.id === config.currentWorkspaceId) ?? null;
      this.currentWorkspace.set(currentWorkspace);
      if (this.configSnapshot) {
        this.configSnapshot.workspaces = structuredClone(config.workspaces);
        this.configSnapshot.currentWorkspaceId = config.currentWorkspaceId;
        this.configSnapshot.themeId = config.themeId;
      }
      this.themeId.set(config.themeId || DEFAULT_THEME_ID);
      this.applyTheme(config.themeId || DEFAULT_THEME_ID);
      const at = config.audioTranscription;
      this.ttsProvider.set(at?.ttsProvider === 'openai-compatible' ? 'openai-compatible' : DEFAULT_TTS_PROVIDER);
      this.ttsBaseUrl.set(at?.ttsBaseUrl?.trim() || DEFAULT_OPENAI_TTS_BASE_URL);
      this.ttsApiKey.set(at?.ttsApiKey ?? '');
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
      this.modelManagerHfToken.set(config.modelManager.huggingFaceToken);
      this.modelManagerCacheLocations.set(
        Array.isArray(config.modelManager.detectedCaches)
          ? config.modelManager.detectedCaches.map((cache) => ({ ...cache }))
          : [],
      );
      return;
    }

    this.configSnapshot = structuredClone(config);
    this.workspaces.set(config.workspaces);

    const currentWorkspace = config.workspaces.find((workspace) => workspace.id === config.currentWorkspaceId) ?? null;
    this.currentWorkspace.set(currentWorkspace);
    this.themeId.set(config.themeId || DEFAULT_THEME_ID);
    this.llmProviders.set(config.llmProviders);
    this.activeLlmModelId.set(config.activeLlmModelId);
    this.audioProvider.set(config.audioTranscription.provider);
    this.audioBaseUrl.set(config.audioTranscription.baseUrl);
    this.audioModel.set(config.audioTranscription.model);
    this.audioApiKey.set(config.audioTranscription.apiKey);
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
    this.ttsApiKey.set(at.ttsApiKey ?? '');
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
    this.allowStagingOverlayCommands.set(!!(wt.allowStagingOverlayCommands ?? false));
    this.commandLineExplainStep.set(!!(wt.commandLineExplainStep ?? false));
    this.exposeAllWorkspaceFiles.set(!!(wt.exposeAllWorkspaceFiles ?? false));
    this.allowWebAccess.set(!!(wt.allowWebAccess ?? false));
    this.searxngBaseUrl.set((wt.searxngBaseUrl ?? '').trim());

    const cc = config.contextCompression ?? getDefaultContextCompression();
    this.contextCompressionEnabled.set(!!cc.enabled);
    this.contextCompressionTriggerRatio.set(cc.triggerRatio);
    this.contextCompressionTargetRatio.set(cc.targetRatio);
    this.contextCompressionProtectTail.set(cc.protectTailMessages);
    this.contextCompressionRecentToolChars.set(cc.recentToolBodyMaxChars);
    this.contextCompressionOldToolChars.set(cc.oldToolBodyMaxChars);
    this.contextCompressionSystemReserve.set(cc.systemReserveRatio);

    this.modelManagerCustomDir.set(config.modelManager.customModelsDir);
    this.modelManagerHfToken.set(config.modelManager.huggingFaceToken);
    this.modelManagerCacheLocations.set(
      Array.isArray(config.modelManager.detectedCaches)
        ? config.modelManager.detectedCaches.map((cache) => ({ ...cache }))
        : [],
    );

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
      this.lmStudioInventory.set([]);
      this.lmStudioInventoryError.set(null);
    }

    if (locAfter?.provider.provider === 'llamacpp' && locAfter.model) {
      if (isPinnedLlamaServerUrlProviderId(locAfter.provider.id)) {
        void this.refreshLlamacppUrlModels();
      } else {
        this.llamacppUrlEmbeddingModelIds.set([]);
        void this.refreshLlamacppManagedModels();
      }
    } else {
      this.llamacppManagedModelIds.set([]);
      this.llamacppUrlEmbeddingModelIds.set([]);
      this.llamacppModelsListError.set(null);
    }

    if (this.selectedSettingsTab() === 'modelManager') {
      void this.refreshModelManagerData();
    }

    this.applyTheme(config.themeId || DEFAULT_THEME_ID);
  }
}
