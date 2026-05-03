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
  /**
   * Optional Hugging Face access token for ``-hf`` / hub downloads (gated or private repos).
   * Injected as ``HF_TOKEN`` and ``HUGGING_FACE_HUB_TOKEN`` when the app spawns managed ``llama-server`` processes.
   */
  huggingFaceToken?: string;
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
  provider: 'openai' | 'lmstudio' | 'llamacpp';
  baseUrl: string;
  apiKey: string;
  /**
   * LM Studio: model id for OpenAI-compatible ``POST /v1/embeddings`` (semantic index).
   * When unset, Python uses ``NEMO_EMBEDDINGS_MODEL`` / defaults.
   */
  embeddingsModel?: string;
  models: LlmModelProfile[];
}

/** Effective chat + embeddings OpenAI base URLs for managed llamacpp (Electron-injected; ports not stored in profile). */
export interface LlamaManagedRuntimeEndpoints {
  baseUrl: string;
  embeddingsBaseUrl: string;
}

/** Single resolved row for Python / UI (provider endpoint + one model preset). `id` is the model preset id. */
export type LlmConnectionConfig = LlmModelProfile &
  Pick<LlmProviderConfig, 'provider' | 'baseUrl' | 'apiKey' | 'embeddingsModel'> & {
    /** Effective OpenAI-compatible embeddings base URL (managed llama embedding server); runtime-only from Electron. */
    embeddingsBaseUrl?: string;
  };

/** Speech-to-text settings forwarded to the Python backend. */
export interface AudioTranscriptionConfig {
  provider: 'openai' | 'disabled' | 'google';
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** Health window: backend log verbosity (Python `nemo` logger + uvicorn noise). */
export interface HealthMonitorConfig {
  logLevel: 'debug' | 'info' | 'warning' | 'error';
  /** Enables live system metric polling in the health window. */
  metricsEnabled: boolean;
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
  healthMonitor: HealthMonitorConfig;
}
