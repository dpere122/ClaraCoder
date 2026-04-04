import type { Workspace } from './workspace';

/** Family-specific tuning template from Settings → Models (synced to Python). */
export type LlmOptimizationPreset = 'generic' | 'qwen';

/** Single LLM endpoint configuration (OpenAI-compatible or LM Studio). */
export interface LlmConnectionConfig {
  id: string;
  name: string;
  provider: 'openai' | 'lmstudio';
  baseUrl: string;
  model: string;
  apiKey: string;
  /** OpenAI-style Chat Completions reasoning effort; empty = omit. */
  reasoningEffort?: '' | 'minimal' | 'low' | 'medium' | 'high';
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
}

/** Speech-to-text settings forwarded to the Python backend. */
export interface AudioTranscriptionConfig {
  provider: 'openai' | 'disabled' | 'google';
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** Workspace agent tool limits and edit-tool surface; synced to Python `/runtime-config`. */
export interface WorkspaceToolsConfig {
  /** Standard: full file, line range, and snippet replace. Strict: line range and full file only (no snippet tool). */
  editToolsMode: 'standard' | 'strict';
  /** Cap on lines returned per `read_workspace_file` text read (PDF pages use the same cap per chunk). */
  maxFileReadLines: number;
  /** Cap on matches returned from `search_workspace`. */
  maxSearchResults: number;
}

/** Root persisted settings for the desktop app (config.json). */
export interface AppConfig {
  currentWorkspaceId: string | null;
  workspaces: Workspace[];
  themeId: string;
  noWorkspaceThemeId: string;
  activeLlmConnectionId: string;
  llmConnections: LlmConnectionConfig[];
  audioTranscription: AudioTranscriptionConfig;
  workspaceTools: WorkspaceToolsConfig;
}
