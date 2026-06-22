import { randomUUID } from 'crypto';
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
  DEFAULT_MANAGED_LLAMA_CHAT_RUN_COMMAND,
  DEFAULT_KOKORO_TTS_VOICE,
  defaultLlamaCppManaged,
  defaultMonacoWorkspaceEditorSettings,
  getDefaultContextCompression,
  inferContextWindowTokens,
  PINNED_LLAMA_CPP_LOCAL_PROVIDER_ID,
  PINNED_LM_STUDIO_PROVIDER_ID,
  PINNED_LLAMA_SERVER_URL_PROVIDER_ID,
  TTS_SPEECH_SPEED_DEFAULT,
} from '../../shared';
import { FIRST_THEME_ID } from '../constants';

/** Bump when persisted `config.json` should reset LLM sources to defaults (see `migrateConfig`). */
export const APP_CONFIG_SCHEMA_VERSION = 4;

/** Seed LLM rows from env (LM Studio + llama-server defaults). */
function getDefaultPlanRetryAttemptsCount(): number {
  const raw = Number.parseInt(process.env.PLAN_RETRY_ATTEMPTS_COUNT || '2', 10);
  if (Number.isNaN(raw)) {
    return 2;
  }
  return Math.min(20, Math.max(0, raw));
}

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
    parallelToolCalls: false,
    optimizationPreset: 'generic',
    maxOutputTokens: 0,
    planRetryAttemptsCount: getDefaultPlanRetryAttemptsCount(),
  };
}

/** Pinned LM Studio row for Settings (stable id; never deleted in UI). */
export function createPinnedLmStudioProvider(): LlmProviderConfig {
  return {
    id: PINNED_LM_STUDIO_PROVIDER_ID,
    name: 'LM Studio Default',
    provider: 'lmstudio',
    baseUrl: process.env.LM_STUDIO_BASE_URL || 'http://127.0.0.1:1234/v1',
    apiKey: process.env.LM_STUDIO_API_KEY || 'lm-studio',
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
    name: 'Llama server (local)',
    provider: 'llamacpp',
    baseUrl: process.env.LLAMACPP_BASE_URL || 'http://127.0.0.1:8080/v1',
    apiKey: process.env.LLAMACPP_API_KEY || '',
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
        parallelToolCalls: false,
        optimizationPreset: 'generic',
        maxOutputTokens: 0,
        planRetryAttemptsCount: getDefaultPlanRetryAttemptsCount(),
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
    parallelToolCalls: false,
    optimizationPreset: 'generic',
    maxOutputTokens: 0,
    planRetryAttemptsCount: getDefaultPlanRetryAttemptsCount(),
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
    apiKey: process.env.LLAMA_SERVER_API_KEY || '',
    models: [defaultLlamacppUrlModelProfile()],
  };
}

export function getDefaultLlmProviders(): LlmProviderConfig[] {
  return [
    createPinnedLmStudioProvider(),
    createPinnedLlamaServerUrlProvider(),
    createPinnedLocalManagedLlamaProvider(),
  ];
}

export function getDefaultAudioTranscription(): AudioTranscriptionConfig {
  return {
    provider: 'openai',
    baseUrl: process.env.OPENAI_BASE_URL || '',
    model: process.env.NEMO_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe',
    apiKey: '',
    talkInputDeviceId: 'default',
    talkSilenceThresholdSeconds: 2,
    ttsVoice: DEFAULT_KOKORO_TTS_VOICE,
    ttsSpeechSpeed: TTS_SPEECH_SPEED_DEFAULT,
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
    exposeAllWorkspaceFiles: false,
  };
}

export function getDefaultHealthMonitor(): HealthMonitorConfig {
  return {
    logLevel: 'info',
    metricsEnabled: false,
  };
}

export function getDefaultModelManagerConfig(): ModelManagerConfig {
  return {
    customModelsDir: path.join(homedir(), 'models'),
    huggingFaceToken: '',
  };
}

/** Fresh config file shape before first save. */
export function createDefaultConfig(): AppConfig {
  const llmProviders = getDefaultLlmProviders();
  return {
    configSchemaVersion: APP_CONFIG_SCHEMA_VERSION,
    currentWorkspaceId: null,
    lastActiveConversationByWorkspaceId: {},
    workspaces: [],
    themeId: FIRST_THEME_ID,
    noWorkspaceThemeId: FIRST_THEME_ID,
    activeLlmModelId: llmProviders[0]?.models[0]?.id ?? 'default-lmstudio',
    llmProviders,
    audioTranscription: getDefaultAudioTranscription(),
    workspaceTools: getDefaultWorkspaceTools(),
    contextCompression: getDefaultContextCompression(),
    healthMonitor: getDefaultHealthMonitor(),
    modelManager: getDefaultModelManagerConfig(),
    chatFontSizeRem: 0.9,
    chatSidebarWidthPercent: 0.75,
    monacoWorkspaceEditor: defaultMonacoWorkspaceEditorSettings(),
  };
}

/** Build a workspace row when migrating legacy `currentWorkspace` string paths. */
export function workspaceFromLegacyPath(oldPath: string, themeId: string): Workspace {
  return {
    id: randomUUID(),
    name: path.basename(oldPath) || 'Default Workspace',
    path: oldPath,
    createdAt: new Date().toISOString(),
    themeId,
  };
}
