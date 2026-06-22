import type { Workspace } from './workspace';

/** Family-specific tuning template from Settings → Models (synced to Python). */
export type LlmOptimizationPreset = 'generic' | 'qwen' | 'capable' | 'gemma';

/** Gemma 4 / LM Studio thinking: boolean-style control (not OpenAI reasoning_effort tiers). */
export type GemmaThinkingMode = 'default' | 'on' | 'off';

/** How sampling (temperature/top_p/top_k) is chosen for Gemma-class models. */
export type GemmaSamplingPreset = 'provider-default' | 'gemma-recommended' | 'custom';

/** Hint for dense vs sparse-expert Gemma layouts (affects defaults and prompt notes only). */
export type GemmaArchitectureHint = 'auto' | 'dense';

/**
 * Per-preset shell commands for managed ``llama-server`` (Electron spawns at Start).
 * Each command must contain exactly one literal ``{{PORT}}``; the manager substitutes the picked TCP port.
 * Empty ``embeddingRunCommand`` (after trim) disables the dedicated embedding process.
 */
export interface LlamaCppManaged {
  chatRunCommand: string;
  embeddingRunCommand: string;
}

/**
 * Per-model preset under a provider (API model id + tuning). Persisted in `llmProviders[].models`.
 * The same fields are merged with provider endpoint data for the Python runtime (`LlmConnectionConfig`).
 */
export interface LlmModelProfile {
  id: string;
  /** Short label in settings lists (not the API model id). */
  name: string;
  /** Provider API model id / id string sent to the server. */
  model: string;
  /** Main context window for this model preset. */
  contextWindowTokens: number;
  /**
   * Chat Completions ``reasoning_effort``; empty = omit parameter.
   * API values: none, minimal, low, medium, high, xhigh. UI aliases ``on`` / ``off`` map to medium / none in the backend.
   * For Gemma-family models the backend omits this parameter; use ``thinkingMode`` instead.
   */
  reasoningEffort?: '' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'on' | 'off';
  /** Gemma / LM Studio boolean thinking guidance (not OpenAI-style reasoning tiers). */
  thinkingMode: GemmaThinkingMode;
  /** Gemma sampling profile (Google recommends temperature=1, top_p=0.95, top_k=64). */
  samplingPreset: GemmaSamplingPreset;
  /** Optional nucleus sampling top_p (0–1); omitted when unset. Gemma “custom” uses this too. */
  topP?: number;
  /** Optional top_k (1–256); often sent via request ``extra_body`` for local OpenAI-compatible servers. */
  topK?: number;
  /** Optional min_p (0–1); llama.cpp / locals often accept as ``min_p`` in ``extra_body``. */
  minP?: number;
  /** Optional OpenAI-style presence_penalty (-2–2). */
  presencePenalty?: number;
  /**
   * Optional llama.cpp-style repeat penalty; sent as ``repeat_penalty`` in ``extra_body`` (not OpenAI’s frequency_penalty).
   */
  repeatPenalty?: number;
  /** Dense vs sparse-expert hint for Gemma 4 (e.g. 26B A4B); ``auto`` infers from the model id. */
  architectureHint: GemmaArchitectureHint;
  /** Sampling temperature for chat completions (0–1). */
  temperature: number;
  /** When true, the model may request multiple tool calls in one completion. */
  parallelToolCalls: boolean;
  /**
   * Optimization template (e.g. Qwen). "generic" uses normal settings; for Qwen models you can still
   * rely on backend auto-heuristics when the model name contains "qwen".
   */
  optimizationPreset: LlmOptimizationPreset;
  /**
   * Hard cap on completion length sent to the API (max_tokens). 0 = let the backend choose (preset/env defaults).
   */
  maxOutputTokens: number;
  /** Max final project-review retry attempts for this model preset. */
  planRetryAttemptsCount: number;
  /** Managed ``llama-server`` launch profile (``llamacpp`` provider). */
  llamaCppManaged?: LlamaCppManaged;
}

/** One API base URL + credentials with many named model presets. */
export interface LlmProviderConfig {
  id: string;
  name: string;
  /** ``llamacpp`` targets llama.cpp’s OpenAI-compatible HTTP server (``llama-server``). */
  provider: 'openai' | 'lmstudio' | 'llamacpp' | 'python-t2i';
  baseUrl: string;
  apiKey: string;
  /**
   * LM Studio: model id for OpenAI-compatible ``POST /v1/embeddings`` (semantic index).
   * When unset, Python uses ``NEMO_EMBEDDINGS_MODEL`` / defaults.
   */
  embeddingsModel?: string;
  /**
   * Optional OpenAI-compatible base URL (``.../v1``) for embeddings when it differs from ``baseUrl``
   * (e.g. remote ``llama-server`` chat on :8080 and embeddings on :8081).
   */
  embeddingsBaseUrl?: string;
  models: LlmModelProfile[];
}

/** Effective chat + embeddings OpenAI base URLs for managed llamacpp (Electron-injected; ports not stored in profile). */
export interface LlamaManagedRuntimeEndpoints {
  baseUrl: string;
  embeddingsBaseUrl: string;
}

/** Single resolved row for Python / UI (provider endpoint + one model preset). `id` is the model preset id. */
export type LlmConnectionConfig = LlmModelProfile &
  Pick<LlmProviderConfig, 'provider' | 'baseUrl' | 'apiKey' | 'embeddingsModel' | 'embeddingsBaseUrl'>;

/** Default Kokoro voice when assistant speech is enabled (American English). */
export const DEFAULT_KOKORO_TTS_VOICE = 'af_heart';

/** Bounds for Settings → Audio → assistant speech speed (sent to Kokoro ``speed``). */
export const TTS_SPEECH_SPEED_MIN = 0.5;
export const TTS_SPEECH_SPEED_MAX = 2;
export const TTS_SPEECH_SPEED_DEFAULT = 1;

/** Speech-to-text settings forwarded to the Python backend. */
export interface AudioTranscriptionConfig {
  provider: 'openai' | 'disabled' | 'google';
  baseUrl: string;
  model: string;
  apiKey: string;
  /**
   * MediaDevices ``deviceId`` for talk-mode capture, or ``"default"`` for browser default.
   * Client-only; ignored by the transcription API runtime.
   */
  talkInputDeviceId?: string;
  /**
   * Seconds of silence after speech before an utterance is sent for transcription (talk mode).
   * Client-only; ignored by the transcription API runtime.
   */
  talkSilenceThresholdSeconds?: number;
  /**
   * Kokoro voice id for assistant TTS (e.g. ``af_heart``).
   * Client-only; sent to the local Python ``POST /tts`` endpoint.
   */
  ttsVoice?: string;
  /**
   * Assistant TTS speed multiplier (0.5–2). Client-only; forwarded to Kokoro.
   */
  ttsSpeechSpeed?: number;
  /**
   * @deprecated Replaced by {@link AudioTranscriptionConfig.ttsVoice} (Kokoro). Migrated on load.
   */
  ttsVoiceId?: string;
}

/** Health window: backend log verbosity (Python `nemo` logger + uvicorn noise). */
export interface HealthMonitorConfig {
  logLevel: 'debug' | 'info' | 'warning' | 'error';
  /** Enables live system metric polling in the health window. */
  metricsEnabled: boolean;
}

/** Local model catalog preferences used by Settings → Model Manager. */
export interface ModelManagerConfig {
  /** Absolute custom directory where local model cards are sourced from. */
  customModelsDir: string;
  /** Shared Hugging Face token for model search and managed llama `-hf` pulls. */
  huggingFaceToken: string;
}

/** Workspace agent tool limits and edit-tool surface; synced to Python `/runtime-config`. */
export interface WorkspaceToolsConfig {
  /** Standard: full file, line range, and snippet replace. Strict: line range and full file only (no snippet tool). */
  editToolsMode: 'standard' | 'strict';
  /** Cap on lines returned per `read_workspace_file` text read (PDF pages use the same cap per chunk). */
  maxFileReadLines: number;
  /** Cap on matches returned from `search_workspace`. */
  maxSearchResults: number;
  /** Default Python codec when tools omit `encoding` (e.g. utf-8, cp1252). */
  defaultWorkspaceEncoding: string;
  /** Default newline mode for edit writes when tools omit `newline`. */
  defaultWorkspaceNewline: 'lf' | 'crlf' | 'preserve';
  /**
   * When true, nested code review may call `run_staging_overlay_command` (ephemeral workspace mirror + argv subprocess).
   * Default false for safety. Optional on disk until migrated.
   */
  allowStagingOverlayCommands?: boolean;
  /**
   * When true, the agent sees every workspace path in tree/list/search/semantic indexing (no built-in skips or root `.gitignore`).
   * Default false. Direct `read_workspace_file` by path already works when filters are on.
   */
  exposeAllWorkspaceFiles?: boolean;
}

/** LangGraph checkpoint compaction; synced to Python `/runtime-config`. */
export interface ContextCompressionConfig {
  /** When false, post-turn checkpoint compaction is skipped. */
  enabled: boolean;
  /** Start compaction when checkpoint estimate ≥ this × usable budget (0.5–0.95). */
  triggerRatio: number;
  /** Reserved for a future compaction phase; Phase 1 compacts tool bodies only. */
  targetRatio: number;
  /** Recent checkpoint messages left verbatim (8–100). */
  protectTailMessages: number;
  /** Max tool body chars for messages just outside the protected tail. */
  recentToolBodyMaxChars: number;
  /** Max tool body chars for older tool messages outside the tail. */
  oldToolBodyMaxChars: number;
  /** Fraction of context window reserved for system prompt + output (0.1–0.5). */
  systemReserveRatio: number;
}

export function getDefaultContextCompression(): ContextCompressionConfig {
  return {
    enabled: true,
    triggerRatio: 0.7,
    targetRatio: 0.55,
    protectTailMessages: 24,
    recentToolBodyMaxChars: 2000,
    oldToolBodyMaxChars: 400,
    systemReserveRatio: 0.25,
  };
}

/** Built-in Monaco themes plus the app-defined `clara-monaco` (CSS-variable aligned). */
export const MONACO_WORKSPACE_EDITOR_THEME_IDS = ['clara-monaco', 'vs', 'vs-dark', 'hc-black', 'hc-light'] as const;
export type MonacoWorkspaceEditorThemeId = (typeof MONACO_WORKSPACE_EDITOR_THEME_IDS)[number];

/**
 * JSON-serializable subset of Monaco `IEditorOptions` for the in-app workspace file editor.
 * Empty `fontFamily` means the renderer uses its built-in CSS font stack.
 */
export interface MonacoWorkspaceEditorSettings {
  /** Color theme for the workspace file editor (`clara-monaco` follows app tokens). */
  theme: MonacoWorkspaceEditorThemeId;
  fontSize: number;
  lineHeight: number;
  /** When empty, the app uses its default monospace stack (CSS variables). */
  fontFamily: string;
  wordWrap: 'on' | 'off' | 'wordWrapColumn' | 'bounded';
  wordWrapColumn: number;
  minimapEnabled: boolean;
  minimapMaxColumn: number;
  minimapRenderCharacters: boolean;
  minimapShowSlider: 'always' | 'mouseover';
  scrollBeyondLastLine: boolean;
  smoothScrolling: boolean;
  renderWhitespace: 'none' | 'boundary' | 'selection' | 'trailing' | 'all';
  renderLineHighlight: 'all' | 'line' | 'none' | 'gutter';
  renderControlCharacters: boolean;
  lineNumbers: 'on' | 'off' | 'relative' | 'interval';
  glyphMargin: boolean;
  folding: boolean;
  guidesIndentation: boolean;
  guidesBracketPairs: boolean;
  bracketPairColorizationEnabled: boolean;
  tabSize: number;
  insertSpaces: boolean;
  detectIndentation: boolean;
  cursorBlinking: 'blink' | 'smooth' | 'phase' | 'expand' | 'solid';
  cursorStyle: 'line' | 'block' | 'underline' | 'line-thin' | 'block-outline' | 'underline-thin';
  cursorWidth: number;
  formatOnPaste: boolean;
  formatOnType: boolean;
  quickSuggestions: boolean;
  autoClosingBrackets: 'always' | 'languageDefined' | 'beforeWhitespace' | 'never';
  autoClosingQuotes: 'always' | 'languageDefined' | 'beforeWhitespace' | 'never';
  acceptSuggestionOnEnter: 'on' | 'off' | 'smart';
  paddingTop: number;
  paddingBottom: number;
}

export function defaultMonacoWorkspaceEditorSettings(): MonacoWorkspaceEditorSettings {
  return {
    theme: 'clara-monaco',
    fontSize: 13,
    lineHeight: 0,
    fontFamily: '',
    wordWrap: 'on',
    wordWrapColumn: 80,
    minimapEnabled: true,
    minimapMaxColumn: 120,
    minimapRenderCharacters: true,
    minimapShowSlider: 'mouseover',
    scrollBeyondLastLine: false,
    smoothScrolling: false,
    renderWhitespace: 'selection',
    renderLineHighlight: 'all',
    renderControlCharacters: false,
    lineNumbers: 'on',
    glyphMargin: true,
    folding: true,
    guidesIndentation: true,
    guidesBracketPairs: true,
    bracketPairColorizationEnabled: true,
    tabSize: 4,
    insertSpaces: true,
    detectIndentation: true,
    cursorBlinking: 'blink',
    cursorStyle: 'line',
    cursorWidth: 0,
    formatOnPaste: false,
    formatOnType: false,
    quickSuggestions: true,
    autoClosingBrackets: 'languageDefined',
    autoClosingQuotes: 'languageDefined',
    acceptSuggestionOnEnter: 'on',
    paddingTop: 0,
    paddingBottom: 0,
  };
}

/** Coerce unknown JSON to valid settings; merge missing keys from defaults. */
export function normalizeMonacoWorkspaceEditorSettings(raw: unknown): {
  settings: MonacoWorkspaceEditorSettings;
  migrated: boolean;
} {
  const base = defaultMonacoWorkspaceEditorSettings();
  let migrated = false;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { settings: base, migrated: true };
  }
  const o = raw as Record<string, unknown>;
  const pickFloat = (key: keyof MonacoWorkspaceEditorSettings, min: number, max: number, fallback: number): number => {
    const v = o[key as string];
    if (typeof v !== 'number' || Number.isNaN(v)) {
      migrated = true;
      return fallback;
    }
    const c = Math.min(max, Math.max(min, v));
    if (c !== v) migrated = true;
    return c;
  };
  const pickInt = (key: keyof MonacoWorkspaceEditorSettings, min: number, max: number, fallback: number): number => {
    const v = o[key as string];
    if (typeof v !== 'number' || Number.isNaN(v)) {
      migrated = true;
      return fallback;
    }
    const n = Math.round(v);
    const c = Math.min(max, Math.max(min, n));
    if (c !== n || c !== v) migrated = true;
    return c;
  };
  const pickBool = (key: keyof MonacoWorkspaceEditorSettings, fallback: boolean): boolean => {
    const v = o[key as string];
    if (typeof v === 'boolean') return v;
    migrated = true;
    return fallback;
  };
  const pickStr = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const v = o[key];
    if (typeof v !== 'string') {
      migrated = true;
      return fallback;
    }
    const t = allowed.includes(v as T) ? (v as T) : fallback;
    if (t !== v) migrated = true;
    return t;
  };

  const ff = o['fontFamily'];
  const fontFamily = typeof ff === 'string' ? ff : '';
  if (typeof ff !== 'string') migrated = true;

  const settings: MonacoWorkspaceEditorSettings = {
    theme: pickStr('theme', MONACO_WORKSPACE_EDITOR_THEME_IDS, base.theme),
    fontSize: pickFloat('fontSize', 8, 48, base.fontSize),
    lineHeight: pickFloat('lineHeight', 0, 64, base.lineHeight),
    fontFamily,
    wordWrap: pickStr('wordWrap', ['on', 'off', 'wordWrapColumn', 'bounded'] as const, base.wordWrap),
    wordWrapColumn: pickInt('wordWrapColumn', 1, 500, base.wordWrapColumn),
    minimapEnabled: pickBool('minimapEnabled', base.minimapEnabled),
    minimapMaxColumn: pickInt('minimapMaxColumn', 1, 200, base.minimapMaxColumn),
    minimapRenderCharacters: pickBool('minimapRenderCharacters', base.minimapRenderCharacters),
    minimapShowSlider: pickStr('minimapShowSlider', ['always', 'mouseover'] as const, base.minimapShowSlider),
    scrollBeyondLastLine: pickBool('scrollBeyondLastLine', base.scrollBeyondLastLine),
    smoothScrolling: pickBool('smoothScrolling', base.smoothScrolling),
    renderWhitespace: pickStr(
      'renderWhitespace',
      ['none', 'boundary', 'selection', 'trailing', 'all'] as const,
      base.renderWhitespace,
    ),
    renderLineHighlight: pickStr(
      'renderLineHighlight',
      ['all', 'line', 'none', 'gutter'] as const,
      base.renderLineHighlight,
    ),
    renderControlCharacters: pickBool('renderControlCharacters', base.renderControlCharacters),
    lineNumbers: pickStr('lineNumbers', ['on', 'off', 'relative', 'interval'] as const, base.lineNumbers),
    glyphMargin: pickBool('glyphMargin', base.glyphMargin),
    folding: pickBool('folding', base.folding),
    guidesIndentation: pickBool('guidesIndentation', base.guidesIndentation),
    guidesBracketPairs: pickBool('guidesBracketPairs', base.guidesBracketPairs),
    bracketPairColorizationEnabled: pickBool('bracketPairColorizationEnabled', base.bracketPairColorizationEnabled),
    tabSize: pickInt('tabSize', 1, 32, base.tabSize),
    insertSpaces: pickBool('insertSpaces', base.insertSpaces),
    detectIndentation: pickBool('detectIndentation', base.detectIndentation),
    cursorBlinking: pickStr(
      'cursorBlinking',
      ['blink', 'smooth', 'phase', 'expand', 'solid'] as const,
      base.cursorBlinking,
    ),
    cursorStyle: pickStr(
      'cursorStyle',
      ['line', 'block', 'underline', 'line-thin', 'block-outline', 'underline-thin'] as const,
      base.cursorStyle,
    ),
    cursorWidth: pickInt('cursorWidth', 0, 10, base.cursorWidth),
    formatOnPaste: pickBool('formatOnPaste', base.formatOnPaste),
    formatOnType: pickBool('formatOnType', base.formatOnType),
    quickSuggestions: pickBool('quickSuggestions', base.quickSuggestions),
    autoClosingBrackets: pickStr(
      'autoClosingBrackets',
      ['always', 'languageDefined', 'beforeWhitespace', 'never'] as const,
      base.autoClosingBrackets,
    ),
    autoClosingQuotes: pickStr(
      'autoClosingQuotes',
      ['always', 'languageDefined', 'beforeWhitespace', 'never'] as const,
      base.autoClosingQuotes,
    ),
    acceptSuggestionOnEnter: pickStr(
      'acceptSuggestionOnEnter',
      ['on', 'off', 'smart'] as const,
      base.acceptSuggestionOnEnter,
    ),
    paddingTop: pickInt('paddingTop', 0, 200, base.paddingTop),
    paddingBottom: pickInt('paddingBottom', 0, 200, base.paddingBottom),
  };

  for (const k of Object.keys(base) as (keyof MonacoWorkspaceEditorSettings)[]) {
    if (!(k in o)) {
      migrated = true;
      break;
    }
  }

  return { settings, migrated };
}

/** Root persisted settings for the desktop app (config.json). */
export interface AppConfig {
  /**
   * Incremented in the main process when a breaking layout requires resetting derived state.
   * Older files omit this field (treated as 0); see `migrateConfig` in load-save.
   */
  configSchemaVersion?: number;
  currentWorkspaceId: string | null;
  /**
   * When switching back to a workspace, restore the last open conversation in that folder.
   * Key is `workspaceId`, or the empty string for the “no workspace / general” conversation bucket.
   */
  lastActiveConversationByWorkspaceId?: Record<string, string>;
  workspaces: Workspace[];
  themeId: string;
  noWorkspaceThemeId: string;
  /** Which model preset is used for chat (`LlmModelProfile.id`). */
  activeLlmModelId: string;
  llmProviders: LlmProviderConfig[];
  audioTranscription: AudioTranscriptionConfig;
  workspaceTools: WorkspaceToolsConfig;
  contextCompression: ContextCompressionConfig;
  healthMonitor: HealthMonitorConfig;
  modelManager: ModelManagerConfig;
  /** Chat message font size in `rem` (e.g. 0.9). Client-only UI preference. */
  chatFontSizeRem?: number;
  /**
   * Chat sidebar width as a fraction of the chat+sidebar layout region (0–1).
   * Client-only UI preference; default 0.75.
   */
  chatSidebarWidthPercent?: number;
  /** Workspace Monaco editor options (client-only). */
  monacoWorkspaceEditor?: MonacoWorkspaceEditorSettings;
}
