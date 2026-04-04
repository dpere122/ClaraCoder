import type { Workspace } from './workspace';

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
}

/** Speech-to-text settings forwarded to the Python backend. */
export interface AudioTranscriptionConfig {
  provider: 'openai' | 'disabled' | 'google';
  baseUrl: string;
  model: string;
  apiKey: string;
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
}
