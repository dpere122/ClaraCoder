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
import { FIRST_THEME_ID } from '../constants';

/** Seed LLM rows from env (OpenAI + LM Studio defaults). */
export function getDefaultLlmConnections(): LlmConnectionConfig[] {
  return [
    {
      id: 'default-openai',
      name: 'OpenAI Default',
      provider: 'openai',
      baseUrl: process.env.OPENAI_BASE_URL || '',
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      apiKey: '',
      reasoningEffort: '',
      temperature: 0,
      parallelToolCalls: false,
      optimizationPreset: 'generic',
      maxOutputTokens: 0,
    },
    {
      id: 'default-lmstudio',
      name: 'LM Studio Local',
      provider: 'lmstudio',
      baseUrl: process.env.LM_STUDIO_BASE_URL || 'http://127.0.0.1:1234/v1',
      model: process.env.LM_STUDIO_MODEL || 'local-model',
      apiKey: process.env.LM_STUDIO_API_KEY || 'lm-studio',
      reasoningEffort: '',
      temperature: 0,
      parallelToolCalls: false,
      optimizationPreset: 'generic',
      maxOutputTokens: 0,
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
  return { logLevel: 'info' };
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
