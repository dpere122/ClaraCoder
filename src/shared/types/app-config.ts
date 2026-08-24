import type { Workspace } from './workspace';
import {
  QWEN_REASONING_EFFORT_VALUES,
  type ChatTemplateReasoningCaps,
} from '../chat-template-reasoning';

const SECRET_OPAQUE = Symbol('SecretValue');
const SECRET_REDACTED = '[REDACTED]';

/**
 * Opaque secret wrapper (brand: {@link SECRET_OPAQUE}).
 *
 * - `toJSON` / `console.log` (`util.inspect`) → {@link SECRET_REDACTED}
 * - `toString` / `valueOf` / `Symbol.toPrimitive` → underlying string (transparent coercion)
 * - {@link unwrap} → underlying string for trusted sinks
 *
 * Disk writers must unwrap/encrypt before persistence (see load-save). Public load/save
 * APIs re-expose plain strings so IPC/renderer `typeof === 'string'` consumers keep working.
 */
export class SecretValue<T extends string = string> extends String {
  readonly [SECRET_OPAQUE] = true as const;
  private readonly _secret: T;

  private constructor(value: T) {
    super(value);
    this._secret = value;
  }

  /** Wrap a plaintext string (or return existing {@link SecretValue} unchanged). */
  static of<T extends string = string>(value: T | SecretValue<T> | null | undefined): SecretValue<T> {
    if (isSecretValue<T>(value)) {
      return value;
    }
    return new SecretValue((value ?? '') as T);
  }

  /** Access the underlying secret string. */
  unwrap(): T {
    return this._secret;
  }

  override toString(): string {
    return String(this._secret);
  }

  override valueOf(): T {
    return this._secret;
  }

  /** Accidental JSON serialization redacts. */
  toJSON(): string {
    return SECRET_REDACTED;
  }

  [Symbol.toPrimitive](_hint?: string): string {
    return String(this._secret);
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return SECRET_REDACTED;
  }
}

/** `JSON.stringify` that keeps {@link SecretValue.toJSON} redaction (for safe logs). */
export function redactSecretsInJson(value: unknown, space?: number): string {
  return JSON.stringify(value, null, space);
}

/** True when value is a {@link SecretValue} instance. */
export function isSecretValue<T extends string = string>(value: unknown): value is SecretValue<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { [SECRET_OPAQUE]?: unknown })[SECRET_OPAQUE] === true &&
    typeof (value as SecretValue<T>).unwrap === 'function'
  );
}

/** Unwrap {@link SecretValue} or pass through plaintext strings. */
export function unwrapSecret(value: unknown): string {
  if (isSecretValue(value)) {
    return value.unwrap();
  }
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof String) {
    return String(value.valueOf());
  }
  return '';
}

/** Coerce unknown config input into a {@link SecretValue} without dropping material. */
export function coerceSecretValue(value: unknown): SecretValue<string> {
  if (isSecretValue(value)) {
    return value;
  }
  if (typeof value === 'string') {
    return SecretValue.of(value);
  }
  if (value instanceof String) {
    return SecretValue.of(String(value.valueOf()));
  }
  if (value == null) {
    return SecretValue.of('');
  }
  // Preserve non-string material as stringified form rather than dropping it.
  return SecretValue.of(String(value));
}

/** Family-specific tuning template from Settings → Models (synced to Python). */
export type LlmOptimizationPreset = 'generic' | 'qwen' | 'gemma';

/** Gemma 4 / LM Studio thinking: boolean-style control (not OpenAI reasoning_effort tiers). */
export type GemmaThinkingMode = 'default' | 'on' | 'off';

/**
 * Chat Completions ``reasoning_effort``; empty = omit parameter.
 * UI aliases ``on`` / ``off`` map to medium / none in the backend.
 */
export type LlmReasoningEffort = '' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'on' | 'off';

/** Ordered options for Settings and the composer Reasoning dropdown (generic / Qwen). */
export const LLM_REASONING_EFFORT_OPTIONS: readonly { value: LlmReasoningEffort; label: string }[] = [
  { value: '', label: 'Default' },
  { value: 'on', label: 'On (medium)' },
  { value: 'off', label: 'Off (none)' },
  { value: 'none', label: 'none' },
  { value: 'minimal', label: 'minimal' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
];

/** Ordered options for Settings and the composer Thinking dropdown (Gemma). */
export const LLM_THINKING_MODE_OPTIONS: readonly { value: GemmaThinkingMode; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

/** Composer / settings change for the active model's thinking or reasoning control. */
export type LlmReasoningSettingChange =
  | { field: 'reasoningEffort'; value: LlmReasoningEffort }
  | { field: 'thinkingMode'; value: GemmaThinkingMode };

/** How sampling (temperature/top_p/top_k) is chosen for Gemma-class models. */
export type GemmaSamplingPreset = 'provider-default' | 'gemma-recommended' | 'custom';

/** Hint for dense vs sparse-expert Gemma layouts (legacy; no longer drives prompts). */
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
  reasoningEffort?: LlmReasoningEffort;
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
  /** Dense vs sparse-expert hint for Gemma 4 (legacy; unused for prompts). */
  architectureHint: GemmaArchitectureHint;
  /** Sampling temperature for chat completions (0–1). */
  temperature: number;
  /** When true, the model may request multiple tool calls in one completion. Parked off (in construction). */
  parallelToolCalls: boolean;
  /**
   * Optimization template (e.g. Qwen). "generic" uses normal settings; for Qwen models you can still
   * rely on backend auto-heuristics when the model name contains "qwen".
   */
  optimizationPreset: LlmOptimizationPreset;
  /**
   * Hard cap on completion length sent to the API (max_tokens). 0 = omit max_tokens (no Clara-side limit).
   */
  maxOutputTokens: number;
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
  apiKey: SecretValue<string>;
  /**
   * LM Studio: model id for OpenAI-compatible ``POST /v1/embeddings`` (semantic index).
   * When unset, Python uses ``CLARA_EMBEDDINGS_MODEL`` / defaults.
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

const GEMMA_THINKING_MODE_VALUES = new Set<string>(LLM_THINKING_MODE_OPTIONS.map((o) => o.value));
const REASONING_EFFORT_VALUES = new Set<string>(LLM_REASONING_EFFORT_OPTIONS.map((o) => o.value));

function effortOptionsFromValues(values: readonly string[]): { value: string; label: string }[] {
  const byValue = new Map<string, { value: string; label: string }>(
    LLM_REASONING_EFFORT_OPTIONS.map((o) => [o.value, o]),
  );
  const opts: { value: string; label: string }[] = [{ value: '', label: 'Default' }];
  for (const v of values) {
    if (!v) {
      continue;
    }
    opts.push(byValue.get(v) ?? { value: v, label: v });
  }
  return opts;
}

/** Qwen 3.8-style effort list (low / medium / xhigh). No on/off aliases. */
export const LLM_QWEN_REASONING_EFFORT_OPTIONS: readonly { value: string; label: string }[] =
  effortOptionsFromValues(QWEN_REASONING_EFFORT_VALUES);

/** Gemma uses boolean thinking; generic uses the full effort list; Qwen uses low/medium/xhigh. */
export function llmReasoningSelectOptions(
  preset: LlmOptimizationPreset | string | undefined,
): readonly { value: string; label: string }[] {
  const p = preset || 'generic';
  if (p === 'gemma') {
    return LLM_THINKING_MODE_OPTIONS;
  }
  if (p === 'qwen') {
    return LLM_QWEN_REASONING_EFFORT_OPTIONS;
  }
  return LLM_REASONING_EFFORT_OPTIONS;
}

/** Current composer/settings select value for the active connection's preset. */
export function llmReasoningSelectValue(
  connection:
    | Pick<LlmModelProfile, 'optimizationPreset' | 'reasoningEffort' | 'thinkingMode'>
    | null
    | undefined,
): string {
  if (!connection) {
    return '';
  }
  if (connection.optimizationPreset === 'gemma') {
    return connection.thinkingMode || 'default';
  }
  return connection.reasoningEffort || '';
}

/** Map a select change to the profile field that preset actually consumes. */
export function llmReasoningSelectChange(
  preset: LlmOptimizationPreset | string | undefined,
  value: string,
): LlmReasoningSettingChange {
  if ((preset || 'generic') === 'gemma') {
    const mode = GEMMA_THINKING_MODE_VALUES.has(value) ? (value as GemmaThinkingMode) : 'default';
    return { field: 'thinkingMode', value: mode };
  }
  const effort = REASONING_EFFORT_VALUES.has(value) ? (value as LlmReasoningEffort) : '';
  return { field: 'reasoningEffort', value: effort };
}

/** Thinking (on/off) control: live scan wins; otherwise Gemma or Qwen preset. */
export function llmThinkingControlVisible(
  preset: LlmOptimizationPreset | string | undefined,
  caps: ChatTemplateReasoningCaps | null | undefined,
): boolean {
  const p = preset || 'generic';
  if (caps) {
    if (caps.enableThinking) {
      return true;
    }
    // Qwen 3.8 templates pair enable_thinking with an effort allow-list; keep the brain
    // when the scan found effort but missed the boolean knob.
    return p === 'qwen' && caps.reasoningEffortValues != null;
  }
  return p === 'gemma' || p === 'qwen';
}

/** Reasoning effort control: live scan wins; otherwise non-Gemma presets. */
export function llmEffortControlVisible(
  preset: LlmOptimizationPreset | string | undefined,
  caps: ChatTemplateReasoningCaps | null | undefined,
): boolean {
  if (caps) {
    return caps.reasoningEffortValues != null;
  }
  return (preset || 'generic') !== 'gemma';
}

/** Effort dropdown options: scanned allow-list plus Default, else Qwen or generic fallback. */
export function llmEffortSelectOptionsFromCaps(
  caps: ChatTemplateReasoningCaps | null | undefined,
  preset?: LlmOptimizationPreset | string,
): readonly { value: string; label: string }[] {
  if (caps?.reasoningEffortValues) {
    return effortOptionsFromValues(caps.reasoningEffortValues);
  }
  return llmReasoningSelectOptions(preset === 'gemma' ? 'generic' : preset);
}

/** Default Kokoro voice when assistant speech is enabled (American English). */
export const DEFAULT_KOKORO_TTS_VOICE = 'af_heart';

/** Default Qwen3-TTS CustomVoice speaker when using OpenAI-compatible remote TTS. */
export const DEFAULT_OPENAI_TTS_VOICE = 'Ryan';

/** Default base URL for OpenAI-compatible assistant TTS (Qwen3-TTS API wrapper). */
export const DEFAULT_OPENAI_TTS_BASE_URL = 'http://127.0.0.1:8083';

/** Assistant TTS backend: local Kokoro (Python) or remote OpenAI-compatible speech API. */
export type TtsProvider = 'kokoro' | 'openai-compatible';

export const DEFAULT_TTS_PROVIDER: TtsProvider = 'kokoro';

/** Speech-to-text backend chosen in Settings → Audio. */
export type AudioTranscriptionProvider = 'openai' | 'disabled' | 'whisper';

/** Default faster-whisper size for local STT (CPU). */
export const DEFAULT_WHISPER_MODEL = 'small';

/** Default OpenAI / OpenAI-compatible transcription model id. */
export const DEFAULT_OPENAI_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';

/** Size picker for Settings → Audio when provider is local Whisper. */
export const WHISPER_MODEL_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'tiny', label: 'tiny — fastest' },
  { value: 'base', label: 'base' },
  { value: 'small', label: 'small — recommended' },
  { value: 'medium', label: 'medium' },
  { value: 'distil-large-v3', label: 'distil-large-v3' },
  { value: 'large-v3-turbo', label: 'large-v3-turbo' },
];

/** faster-whisper size alias → Hugging Face repo (same map as the Python dep provider). */
export const WHISPER_SIZE_REPOS: Readonly<Record<string, string>> = {
  tiny: 'Systran/faster-whisper-tiny',
  base: 'Systran/faster-whisper-base',
  small: 'Systran/faster-whisper-small',
  medium: 'Systran/faster-whisper-medium',
  'distil-large-v3': 'Systran/faster-distil-whisper-large-v3',
  'large-v3-turbo': 'mobiuslabsgmbh/faster-whisper-large-v3-turbo',
};

const WHISPER_MODEL_IDS = new Set<string>(WHISPER_MODEL_OPTIONS.map((o) => o.value));

/** Hugging Face Hub cache folder for ``org/name`` (``models--org--name``). */
export function whisperHubCacheDirname(repoId: string): string {
  return 'models--' + repoId.replace(/\//g, '--');
}

/** True when ``model`` is a known faster-whisper size id. */
export function isWhisperModelId(model: string): boolean {
  return WHISPER_MODEL_IDS.has(model);
}

/** Settings / Dependencies size picker limited to Hub weights already on disk. */
export function filterDownloadedWhisperModels(
  downloaded: readonly string[],
): readonly { value: string; label: string }[] {
  const set = new Set(downloaded);
  return WHISPER_MODEL_OPTIONS.filter((o) => set.has(o.value));
}

/**
 * Settings Audio model: keep the persisted size when it is on disk; otherwise the first
 * downloaded size in {@link WHISPER_MODEL_OPTIONS} order. Empty download list leaves ``persisted``.
 */
export function pickWhisperSettingsModel(
  persisted: string,
  downloaded: readonly string[],
): string {
  if (downloaded.includes(persisted)) {
    return persisted;
  }
  return filterDownloadedWhisperModels(downloaded)[0]?.value ?? persisted;
}

/** Default model name for the given STT provider. */
export function defaultModelForAudioProvider(provider: AudioTranscriptionProvider): string {
  return provider === 'whisper' ? DEFAULT_WHISPER_MODEL : DEFAULT_OPENAI_TRANSCRIBE_MODEL;
}

/** Bounds for Settings → Audio → assistant speech speed (sent to Kokoro ``speed``). */
export const TTS_SPEECH_SPEED_MIN = 0.5;
export const TTS_SPEECH_SPEED_MAX = 2;
export const TTS_SPEECH_SPEED_DEFAULT = 1;

/** Bounds for Settings → General → app UI font size (scales `html` root; rem-based UI follows). */
export const UI_FONT_SIZE_REM_MIN = 0.8;
export const UI_FONT_SIZE_REM_MAX = 1.4;
export const UI_FONT_SIZE_REM_DEFAULT = 1.1;
export const UI_FONT_SIZE_REM_STEP = 0.1;

/** Coerce persisted or live UI font size to the allowed rem multiplier range. */
export function clampUiFontSizeRem(value: unknown): number {
  const n = typeof value === 'number' && !Number.isNaN(value) ? value : UI_FONT_SIZE_REM_DEFAULT;
  return Math.min(UI_FONT_SIZE_REM_MAX, Math.max(UI_FONT_SIZE_REM_MIN, +n.toFixed(1)));
}

/** Max content width when chat is expanded to the main panel. Sidebar chat is always full width. */
export type ChatContainerSize = 'narrow' | 'standard' | 'full-width';

export const CHAT_CONTAINER_SIZE_OPTIONS: readonly { value: ChatContainerSize; label: string }[] = [
  { value: 'narrow', label: 'Narrow' },
  { value: 'standard', label: 'Standard' },
  { value: 'full-width', label: 'Full width' },
];

export const DEFAULT_CHAT_CONTAINER_SIZE: ChatContainerSize = 'standard';

const CHAT_CONTAINER_SIZE_VALUES = new Set<ChatContainerSize>(
  CHAT_CONTAINER_SIZE_OPTIONS.map((opt) => opt.value),
);

/** Coerce persisted chat container size to a known value. */
export function normalizeChatContainerSize(value: unknown): ChatContainerSize {
  if (typeof value === 'string' && CHAT_CONTAINER_SIZE_VALUES.has(value as ChatContainerSize)) {
    return value as ChatContainerSize;
  }
  return DEFAULT_CHAT_CONTAINER_SIZE;
}

/** Restore chat sidebar chrome from config. Collapsed wins over the expanded overlay. */
export function resolveChatWindowState(
  config: Pick<AppConfig, 'chatSidebarCollapsed' | 'chatExpandedToMainPanel'>,
): { collapsed: boolean; expanded: boolean } {
  const collapsed = config.chatSidebarCollapsed === true;
  return {
    collapsed,
    expanded: !collapsed && config.chatExpandedToMainPanel === true,
  };
}

/** Speech-to-text settings forwarded to the Python backend. */
export interface AudioTranscriptionConfig {
  provider: AudioTranscriptionProvider;
  baseUrl: string;
  model: string;
  apiKey: SecretValue<string>;
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
   * Kokoro voice id for assistant TTS (e.g. ``af_heart``), or remote speaker name (e.g. ``Ryan``).
   * Client-only; sent to local Kokoro or remote ``POST /v1/audio/speech``.
   */
  ttsVoice?: string;
  /**
   * Assistant TTS speed multiplier (0.5–2). Client-only; forwarded to TTS backend.
   */
  ttsSpeechSpeed?: number;
  /**
   * Assistant TTS backend: local Kokoro or OpenAI-compatible remote speech API.
   * Client-only; read by Electron main when streaming TTS.
   */
  ttsProvider?: TtsProvider;
  /**
   * OpenAI-compatible TTS base URL (``/v1`` suffix optional). Used when {@link ttsProvider} is
   * ``openai-compatible``.
   */
  ttsBaseUrl?: string;
  /**
   * Optional Bearer token for OpenAI-compatible TTS. Client-only.
   */
  ttsApiKey?: SecretValue<string>;
  /**
   * Default OpenAI-compatible TTS ``instructions`` (mood/tone) when the model omits ``[[tts_mood: ...]]``.
   * Client-only; ignored by Kokoro.
   */
  ttsDefaultInstructions?: string;
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
  /**
   * Absolute directory for local / downloaded models (hub folders + GGUF).
   * Default is ``~/ClaraCoder/models`` (outside app install and userData).
   */
  customModelsDir: string;
  /** Shared Hugging Face token for model search and managed llama `-hf` pulls. */
  huggingFaceToken: SecretValue<string>;
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
   * When true and Auto-apply is off, asks the model for a one-line description and a low/medium/high risk
   * rating for each `run_command` approval request, shown on the confirmation card. Default false.
   */
  commandLineExplainStep?: boolean;
  /**
   * When true, the agent sees every workspace path in tree/list/search/semantic indexing (no built-in skips or root `.gitignore`).
   * Default false. Direct `read_workspace_file` by path already works when filters are on.
   */
  exposeAllWorkspaceFiles?: boolean;
  /**
   * When true, bind `web_search` (SearXNG) and `fetch_url` agent tools.
   * Default false. Requires a reachable SearXNG base URL for search.
   */
  allowWebAccess?: boolean;
  /** Base URL of a SearXNG instance (e.g. `http://127.0.0.1:8080`). Empty until configured. */
  searxngBaseUrl?: string;
  /**
   * Extra directories prepended onto agent `run_command` PATH (one per line).
   * Login-shell PATH and common user bins (`~/.local/bin`, `~/.cargo/bin`, …) are
   * included automatically on packaged GUI launches.
   */
  extraUserPath?: string;
  /**
   * When true, the agent auto-runs Black/Prettier after edits and binds the format_* tools.
   * Default false. Optional on disk until migrated.
   */
  enableAgentFormatters?: boolean;
}

/** LangGraph checkpoint compaction; synced to Python `/runtime-config`. */
export interface ContextCompressionConfig {
  /**
   * When false, checkpoint compaction is skipped (post-turn and mid-turn before
   * each model call).
   */
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

/** A selectable font choice for the app-wide font pickers (Settings → General). */
export interface FontFamilyOption {
  label: string;
  /** CSS `font-family` value. Empty string means "theme default" (clears the override). */
  stack: string;
}

/**
 * An OS-installed font family, as reported by the main process (`list-system-fonts` IPC,
 * backed by the `font-list` package: `fc-list` on Linux, PowerShell on Windows, CoreText on macOS).
 */
export interface SystemFontInfo {
  /** Raw family name as reported by the OS, e.g. `DejaVu Sans Mono`. Use for display. */
  name: string;
  /** CSS-safe `font-family` value (quoted when needed), e.g. `"DejaVu Sans Mono"`. Use for the stack. */
  familyName: string;
  /** Whether the OS reports this family as monospace (used to bias sort order per picker). */
  monospace: boolean;
}

/**
 * App-wide UI font choices ({@link AppConfig.uiFontFamily}). Applies to all UI text —
 * chat messages, buttons, nav, dialogs — everywhere *except* the Monaco editor and
 * rendered markdown code blocks, which follow {@link CODE_FONT_FAMILY_OPTIONS} instead.
 */
export const UI_FONT_FAMILY_OPTIONS: readonly FontFamilyOption[] = [
  { label: 'Theme default', stack: '' },
  { label: 'JetBrains Mono (default look)', stack: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace" },
  { label: 'Inter', stack: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" },
  { label: 'System UI', stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" },
  { label: 'Verdana', stack: "Verdana, Geneva, sans-serif" },
  { label: 'Georgia', stack: "Georgia, 'Times New Roman', serif" },
];

/**
 * Code font choices ({@link AppConfig.codeFontFamily}). Applies to rendered markdown code
 * blocks in chat and overrides the Monaco editor's own font family setting
 * ({@link MonacoWorkspaceEditorSettings.fontFamily}) when set.
 */
export const CODE_FONT_FAMILY_OPTIONS: readonly FontFamilyOption[] = [
  { label: 'Theme default', stack: '' },
  { label: 'JetBrains Mono', stack: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace" },
  { label: 'Fira Code', stack: "'Fira Code', 'JetBrains Mono', 'Cascadia Code', Consolas, monospace" },
  { label: 'Source Code Pro', stack: "'Source Code Pro', 'JetBrains Mono', monospace" },
  { label: 'IBM Plex Mono', stack: "'IBM Plex Mono', 'JetBrains Mono', monospace" },
  { label: 'Cascadia Code', stack: "'Cascadia Code', Consolas, 'JetBrains Mono', monospace" },
  { label: 'Consolas', stack: "Consolas, 'Courier New', monospace" },
];

/** Built-in Monaco color themes for the workspace file editor. */
export const MONACO_WORKSPACE_EDITOR_THEME_IDS = ['vs-dark', 'vs', 'hc-black', 'hc-light'] as const;
export type MonacoWorkspaceEditorThemeId = (typeof MONACO_WORKSPACE_EDITOR_THEME_IDS)[number];

/**
 * JSON-serializable subset of Monaco `IEditorOptions` for the in-app workspace file editor.
 * Empty `fontFamily` means the renderer uses its built-in CSS font stack.
 */
export interface MonacoWorkspaceEditorSettings {
  /** Color theme for the workspace file editor. */
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
  stickyScrollEnabled: boolean;
  formatOnSave: boolean;
  parameterHintsEnabled: boolean;
  hoverEnabled: boolean;
  hoverDelay: number;
}

export function defaultMonacoWorkspaceEditorSettings(): MonacoWorkspaceEditorSettings {
  return {
    theme: 'vs-dark',
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
    stickyScrollEnabled: true,
    formatOnSave: false,
    parameterHintsEnabled: true,
    hoverEnabled: true,
    hoverDelay: 500,
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
    stickyScrollEnabled: pickBool('stickyScrollEnabled', base.stickyScrollEnabled),
    formatOnSave: pickBool('formatOnSave', base.formatOnSave),
    parameterHintsEnabled: pickBool('parameterHintsEnabled', base.parameterHintsEnabled),
    hoverEnabled: pickBool('hoverEnabled', base.hoverEnabled),
    hoverDelay: pickInt('hoverDelay', 0, 5000, base.hoverDelay),
  };

  for (const k of Object.keys(base) as (keyof MonacoWorkspaceEditorSettings)[]) {
    if (!(k in o)) {
      migrated = true;
      break;
    }
  }

  return { settings, migrated };
}

/** Scroll position for one workspace Monaco file tab (client-only). */
export interface WorkspaceMonacoEditorScrollState {
  scrollTop: number;
  scrollLeft: number;
}

/** Per-workspace Monaco scroll positions keyed by workspace-relative file path. */
export type WorkspaceMonacoScrollByWorkspaceId = Record<
  string,
  Record<string, WorkspaceMonacoEditorScrollState>
>;

/** Coerce unknown persisted scroll JSON; drops invalid entries. */
export function normalizeWorkspaceMonacoScrollByWorkspaceId(raw: unknown): {
  scrollByWorkspaceId: WorkspaceMonacoScrollByWorkspaceId;
  migrated: boolean;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { scrollByWorkspaceId: {}, migrated: raw != null };
  }
  const scrollByWorkspaceId: WorkspaceMonacoScrollByWorkspaceId = {};
  let migrated = false;
  for (const [workspaceId, pathsRaw] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof workspaceId !== 'string' || !workspaceId.trim()) {
      migrated = true;
      continue;
    }
    if (!pathsRaw || typeof pathsRaw !== 'object' || Array.isArray(pathsRaw)) {
      migrated = true;
      continue;
    }
    const paths: Record<string, WorkspaceMonacoEditorScrollState> = {};
    for (const [relativePath, scrollRaw] of Object.entries(pathsRaw as Record<string, unknown>)) {
      if (typeof relativePath !== 'string' || !relativePath.trim()) {
        migrated = true;
        continue;
      }
      if (!scrollRaw || typeof scrollRaw !== 'object' || Array.isArray(scrollRaw)) {
        migrated = true;
        continue;
      }
      const scrollTop = (scrollRaw as { scrollTop?: unknown }).scrollTop;
      const scrollLeft = (scrollRaw as { scrollLeft?: unknown }).scrollLeft;
      if (typeof scrollTop !== 'number' || Number.isNaN(scrollTop) || scrollTop < 0) {
        migrated = true;
        continue;
      }
      if (typeof scrollLeft !== 'number' || Number.isNaN(scrollLeft) || scrollLeft < 0) {
        migrated = true;
        continue;
      }
      paths[relativePath.replace(/\\/g, '/').trim()] = { scrollTop, scrollLeft };
    }
    if (Object.keys(paths).length > 0) {
      scrollByWorkspaceId[workspaceId] = paths;
    }
  }
  return { scrollByWorkspaceId, migrated };
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
  /** The single app-wide UI theme id (see `THEMES` in `theme-selector.ts`). Not per-workspace. */
  themeId: string;
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
   * App-wide UI text scale as a rem multiplier on the document root (e.g. 1.1 → 110% of browser default).
   * Scales rem-based UI chrome; chat messages and Monaco keep their own size settings.
   */
  uiFontSizeRem?: number;
  /**
   * App-wide UI font family override (CSS `font-family` value). Empty/undefined = theme default.
   * Applies everywhere except the Monaco editor and rendered markdown code blocks (see {@link codeFontFamily}).
   */
  uiFontFamily?: string;
  /**
   * Code font family override (CSS `font-family` value). Empty/undefined = theme default.
   * Applies to rendered markdown code blocks and overrides {@link MonacoWorkspaceEditorSettings.fontFamily}
   * when set.
   */
  codeFontFamily?: string;
  /**
   * Chat sidebar width as a fraction of the chat+sidebar layout region (0–1).
   * Client-only UI preference; default 1/3 (yields a 1:2:1 workspace:chat:sidebar layout).
   */
  chatSidebarWidthPercent?: number;
  /**
   * When true, the chat sidebar is collapsed to the chevron bar.
   * Client-only UI preference; default false.
   */
  chatSidebarCollapsed?: boolean;
  /**
   * When true, active chat overlays the main editor stage.
   * Ignored while {@link chatSidebarCollapsed} is true. Client-only; default false.
   */
  chatExpandedToMainPanel?: boolean;
  /**
   * Max content width when chat is expanded to the main panel.
   * Sidebar chat is always full width regardless of this setting.
   */
  chatContainerSize?: ChatContainerSize;
  /** Workspace Monaco editor options (client-only). */
  monacoWorkspaceEditor?: MonacoWorkspaceEditorSettings;
  /** Per-workspace Monaco scroll positions for open file tabs (client-only). */
  workspaceMonacoScrollByWorkspaceId?: WorkspaceMonacoScrollByWorkspaceId;
}
