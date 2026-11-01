import { randomUUID } from 'crypto';
import { DEFAULT_SCREENSHOT_RETENTION } from '../../shared/screenshot-retention';
import { homedir } from 'os';
import path = require('path');
import type {
  AppConfig,
  AudioTranscriptionConfig,
  HealthMonitorConfig,
  LlmModelProfile,
  LlmProviderConfig,
  ModelManagerConfig,
  Workspace,
  WorkspaceToolsConfig,
} from '../../shared';
import {
  DEFAULT_CHAT_CONTAINER_SIZE,
  DEFAULT_CHAT_THINKING_DISPLAY,
  DEFAULT_MANAGED_LLAMA_CHAT_RUN_COMMAND,
  DEFAULT_MANAGED_LLAMA_SOURCE_NAME,
  DEFAULT_KOKORO_TTS_VOICE,
  DEFAULT_OPENAI_TTS_BASE_URL,
  DEFAULT_TTS_PROVIDER,
  DEFAULT_WHISPER_MODEL,
  defaultLlamaCppManaged,
  defaultMonacoWorkspaceEditorSettings,
  getDefaultContextCompression,
  inferContextWindowTokens,
  PINNED_LLAMA_CPP_LOCAL_PROVIDER_ID,
  PINNED_LM_STUDIO_PROVIDER_ID,
  PINNED_LLAMA_SERVER_URL_PROVIDER_ID,
  PINNED_OPENROUTER_PROVIDER_ID,
  OPENROUTER_DEFAULT_BASE_URL,
  TTS_SPEECH_SPEED_DEFAULT,
} from '../../shared';
import { SecretValue } from '../../shared/types/app-config';
import { FIRST_THEME_ID } from '../constants';

/** Bump when persisted `config.json` needs a one-time migration step (see `migrateConfig`). */
export const APP_CONFIG_SCHEMA_VERSION = 8;

function defaultLmStudioModelProfile(): LlmModelProfile {
  const defaultLmStudioModel = process.env.LM_STUDIO_MODEL || 'local-model';
  return {
    id: 'default-lmstudio',
    name: 'LM Studio Local',
    model: defaultLmStudioModel,
    contextWindowTokens: inferContextWindowTokens(defaultLmStudioModel, 'lmstudio'),
    reasoningEffort: '',
    thinkingMode: 'default',
    samplingPreset: 'provider-default',
    architectureHint: 'auto',
    temperature: 0,
    parallelToolCalls: true,
    optimizationPreset: 'generic',
    maxOutputTokens: 0,
  };
}

/** Pinned LM Studio row for Settings (stable id; never deleted in UI). */
export function createPinnedLmStudioProvider(): LlmProviderConfig {
  return {
    id: PINNED_LM_STUDIO_PROVIDER_ID,
    name: 'LM Studio Default',
    provider: 'lmstudio',
    baseUrl: process.env.LM_STUDIO_BASE_URL || 'http://127.0.0.1:1234/v1',
    apiKey: SecretValue.of(process.env.LM_STUDIO_API_KEY || 'lm-studio'),
    models: [defaultLmStudioModelProfile()],
  };
}

/** Pinned managed llama-server on this machine (stable id; never deleted in UI). */
export function createPinnedLocalManagedLlamaProvider(): LlmProviderConfig {
  const defaultLlamacppModel = process.env.LLAMACPP_MODEL || 'local-model';
  const chatRunCommand =
    process.env.LLAMACPP_CHAT_RUN_COMMAND ||
    DEFAULT_MANAGED_LLAMA_CHAT_RUN_COMMAND;
  const embeddingRunCommand = process.env.LLAMACPP_EMBEDDING_RUN_COMMAND || '';
  return {
    id: PINNED_LLAMA_CPP_LOCAL_PROVIDER_ID,
    name: DEFAULT_MANAGED_LLAMA_SOURCE_NAME,
    provider: 'llamacpp',
    baseUrl: process.env.LLAMACPP_BASE_URL || 'http://127.0.0.1:8080/v1',
    apiKey: SecretValue.of(process.env.LLAMACPP_API_KEY || ''),
    models: [
      {
        id: 'default-llamacpp',
        name: 'llama.cpp local',
        model: defaultLlamacppModel,
        contextWindowTokens: inferContextWindowTokens(defaultLlamacppModel, 'llamacpp'),
        reasoningEffort: '',
        thinkingMode: 'default',
        samplingPreset: 'provider-default',
        architectureHint: 'auto',
        temperature: 0,
        parallelToolCalls: true,
        optimizationPreset: 'generic',
        maxOutputTokens: 0,
        llamaCppManaged: {
          ...defaultLlamaCppManaged(),
          chatRunCommand,
          embeddingRunCommand,
        },
      },
    ],
  };
}
function defaultLlamacppUrlModelProfile(): LlmModelProfile {
  const defaultM = process.env.LLAMA_SERVER_DEFAULT_MODEL || 'local-model';
  return {
    id: 'default-llama-server-url',
    name: 'Llama server (URL)',
    model: defaultM,
    contextWindowTokens: inferContextWindowTokens(defaultM, 'llamacpp'),
    reasoningEffort: '',
    thinkingMode: 'default',
    samplingPreset: 'provider-default',
    architectureHint: 'auto',
    temperature: 0,
    parallelToolCalls: true,
    optimizationPreset: 'generic',
    maxOutputTokens: 0,
  };
}

/** Pinned remote ``llama-server`` row (OpenAI-compatible URL; no managed Start). */
export function createPinnedLlamaServerUrlProvider(): LlmProviderConfig {
  const chatBase = process.env.LLAMA_SERVER_BASE_URL || 'http://127.0.0.1:8080/v1';
  const embeddingsBase =
    process.env.LLAMA_SERVER_EMBEDDINGS_BASE_URL || 'http://127.0.0.1:8081/v1';
  return {
    id: PINNED_LLAMA_SERVER_URL_PROVIDER_ID,
    name: 'Llama server (URL)',
    provider: 'llamacpp',
    baseUrl: chatBase,
    embeddingsBaseUrl: embeddingsBase,
    apiKey: SecretValue.of(process.env.LLAMA_SERVER_API_KEY || ''),
    models: [defaultLlamacppUrlModelProfile()],
  };
}

function defaultOpenRouterModelProfile(): LlmModelProfile {
  return {
    id: 'default-openrouter',
    name: 'OpenRouter',
    model: '',
    contextWindowTokens: inferContextWindowTokens('', 'openrouter'),
    reasoningEffort: '',
    thinkingMode: 'default',
    samplingPreset: 'provider-default',
    architectureHint: 'auto',
    temperature: 0,
    parallelToolCalls: true,
    optimizationPreset: 'generic',
    maxOutputTokens: 0,
  };
}

/** Pinned OpenRouter row (stable id; never deleted in UI). */
export function createPinnedOpenRouterProvider(): LlmProviderConfig {
  return {
    id: PINNED_OPENROUTER_PROVIDER_ID,
    name: 'OpenRouter',
    provider: 'openrouter',
    baseUrl: process.env.OPENROUTER_BASE_URL || OPENROUTER_DEFAULT_BASE_URL,
    apiKey: SecretValue.of(process.env.OPENROUTER_API_KEY || ''),
    models: [defaultOpenRouterModelProfile()],
  };
}

export function getDefaultLlmProviders(): LlmProviderConfig[] {
  return [
    createPinnedLmStudioProvider(),
    createPinnedLlamaServerUrlProvider(),
    createPinnedLocalManagedLlamaProvider(),
    createPinnedOpenRouterProvider(),
  ];
}

export function getDefaultAudioTranscription(): AudioTranscriptionConfig {
  return {
    provider: 'whisper',
    baseUrl: process.env.OPENAI_BASE_URL || '',
    model: DEFAULT_WHISPER_MODEL,
    apiKey: SecretValue.of(''),
    talkInputDeviceId: 'default',
    talkSilenceThresholdSeconds: 2,
    ttsVoice: DEFAULT_KOKORO_TTS_VOICE,
    ttsSpeechSpeed: TTS_SPEECH_SPEED_DEFAULT,
    ttsProvider: DEFAULT_TTS_PROVIDER,
    ttsBaseUrl: DEFAULT_OPENAI_TTS_BASE_URL,
    ttsApiKey: SecretValue.of(''),
    ttsDefaultInstructions: '',
  };
}

export function getDefaultWorkspaceTools(): WorkspaceToolsConfig {
  return {
    editToolsMode: 'standard',
    maxFileReadLines: 400,
    maxSearchResults: 40,
    defaultWorkspaceEncoding: 'utf-8',
    defaultWorkspaceNewline: 'lf',
    allowStagingOverlayCommands: false,
    commandLineExplainStep: false,
    exposeAllWorkspaceFiles: false,
    allowWebAccess: false,
    searxngBaseUrl: '',
    webSearchProvider: 'auto',
    webSearchEngines: [],
    webSearchUserAgent: '',
    webSearchCooldownSeconds: 300,
    screenshotRetention: { ...DEFAULT_SCREENSHOT_RETENTION },
    extraUserPath: '',
    enableAgentFormatters: false,
  };
}

export function getDefaultHealthMonitor(): HealthMonitorConfig {
  return {
    logLevel: 'info',
    metricsEnabled: false,
  };
}

/**
 * Default on-disk library for downloaded / local GGUF models.
 * Lives under the user home (not app install or ``userData``) so large
 * weights do not bloat the Clara Coder app directory.
 * Linux: ``~/ClaraCoder/models`` · Windows: ``%USERPROFILE%\ClaraCoder\models``.
 */
export function getDefaultCustomModelsDir(): string {
  return path.join(homedir(), 'ClaraCoder', 'models');
}

export function getDefaultModelManagerConfig(): ModelManagerConfig {
  return {
    customModelsDir: getDefaultCustomModelsDir(),
    huggingFaceToken: SecretValue.of(''),
  };
}

/** Fresh config file shape before first save. */
export function createDefaultConfig(): AppConfig {
  const llmProviders = getDefaultLlmProviders();
  return {
    configSchemaVersion: APP_CONFIG_SCHEMA_VERSION,
    currentWorkspaceId: null,
    defaultHomePageOnStart: false,
    lastActiveConversationByWorkspaceId: {},
    workspaceMonacoScrollByWorkspaceId: {},
    workspaceOpenTabsByWorkspaceId: {},
    workspaces: [],
    themeId: FIRST_THEME_ID,
    activeLlmModelId: llmProviders[0]?.models[0]?.id ?? 'default-lmstudio',
    llmProviders,
    audioTranscription: getDefaultAudioTranscription(),
    workspaceTools: getDefaultWorkspaceTools(),
    mcpServers: [],
    contextCompression: getDefaultContextCompression(),
    healthMonitor: getDefaultHealthMonitor(),
    modelManager: getDefaultModelManagerConfig(),
    chatFontSizeRem: 0.9,
    uiFontSizeRem: 1.1,
    chatSidebarWidthPercent: 1 / 3,
    chatSidebarCollapsed: false,
    chatExpandedToMainPanel: false,
    chatContainerSize: DEFAULT_CHAT_CONTAINER_SIZE,
    chatThinkingDisplay: DEFAULT_CHAT_THINKING_DISPLAY,
    confirmMove: true,
    uiFontFamily: '',
    codeFontFamily: '',
    monacoWorkspaceEditor: defaultMonacoWorkspaceEditorSettings(),
  };
}

/** Build a workspace row when migrating legacy `currentWorkspace` string paths. */
export function workspaceFromLegacyPath(oldPath: string): Workspace {
  return {
    id: randomUUID(),
    name: path.basename(oldPath) || 'Default Workspace',
    path: oldPath,
    createdAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
  };
}
