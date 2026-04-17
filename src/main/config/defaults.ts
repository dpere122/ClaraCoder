import { randomUUID } from 'crypto';
import path = require('path');
import type {
  AppConfig,
  AudioTranscriptionConfig,
  HealthMonitorConfig,
  LlmConnectionConfig,
  Workspace,
  WorkspaceToolsConfig,
} from '../../shared';
import { inferContextWindowTokens } from '../../shared';
import { FIRST_THEME_ID } from '../constants';

/** Seed LLM rows from env (OpenAI + LM Studio defaults). */
function getDefaultPlanRetryAttemptsCount(): number {
  const raw = Number.parseInt(process.env.PLAN_RETRY_ATTEMPTS_COUNT || '2', 10);
  if (Number.isNaN(raw)) {
    return 2;
  }
  return Math.min(20, Math.max(0, raw));
}

export function getDefaultLlmConnections(): LlmConnectionConfig[] {
  const defaultOpenAiModel = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const defaultLmStudioModel = process.env.LM_STUDIO_MODEL || 'local-model';
  return [
    {
      id: 'default-openai',
      name: 'OpenAI Default',
      provider: 'openai',
      baseUrl: process.env.OPENAI_BASE_URL || '',
      model: defaultOpenAiModel,
      contextWindowTokens: inferContextWindowTokens(defaultOpenAiModel, 'openai'),
      apiKey: '',
      reasoningEffort: '',
      thinkingMode: 'default',
      samplingPreset: 'provider-default',
      architectureHint: 'auto',
      temperature: 0,
      parallelToolCalls: false,
      optimizationPreset: 'generic',
      maxOutputTokens: 0,
      planRetryAttemptsCount: getDefaultPlanRetryAttemptsCount(),
    },
    {
      id: 'default-lmstudio',
      name: 'LM Studio Local',
      provider: 'lmstudio',
      baseUrl: process.env.LM_STUDIO_BASE_URL || 'http://127.0.0.1:1234/v1',
      model: defaultLmStudioModel,
      contextWindowTokens: inferContextWindowTokens(defaultLmStudioModel, 'lmstudio'),
      apiKey: process.env.LM_STUDIO_API_KEY || 'lm-studio',
      reasoningEffort: '',
      thinkingMode: 'default',
      samplingPreset: 'provider-default',
      architectureHint: 'auto',
      temperature: 0,
      parallelToolCalls: false,
      optimizationPreset: 'generic',
      maxOutputTokens: 0,
      planRetryAttemptsCount: getDefaultPlanRetryAttemptsCount(),
    },
  ];
}

export function getDefaultAudioTranscription(): AudioTranscriptionConfig {
  return {
    provider: 'openai',
    baseUrl: process.env.OPENAI_BASE_URL || '',
    model: process.env.NEMO_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe',
    apiKey: '',
  };
}

export function getDefaultWorkspaceTools(): WorkspaceToolsConfig {
  return {
    editToolsMode: 'standard',
    maxFileReadLines: 400,
    maxSearchResults: 40,
    defaultWorkspaceEncoding: 'utf-8',
    defaultWorkspaceNewline: 'lf',
  };
}

export function getDefaultHealthMonitor(): HealthMonitorConfig {
  return {
    logLevel: 'info',
    metricsEnabled: false,
  };
}

/** Fresh config file shape before first save. */
export function createDefaultConfig(): AppConfig {
  const llmConnections = getDefaultLlmConnections();
  return {
    currentWorkspaceId: null,
    workspaces: [],
    themeId: FIRST_THEME_ID,
    noWorkspaceThemeId: FIRST_THEME_ID,
    activeLlmConnectionId: llmConnections[0].id,
    llmConnections,
    audioTranscription: getDefaultAudioTranscription(),
    workspaceTools: getDefaultWorkspaceTools(),
    healthMonitor: getDefaultHealthMonitor(),
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
