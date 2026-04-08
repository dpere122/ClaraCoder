import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path = require('path');
const syncFs = require('fs');
import type { AppConfig, HealthMonitorConfig, LlmConnectionConfig, WorkspaceToolsConfig } from '../../shared';
import { inferContextWindowTokens } from '../../shared';
import { FIRST_THEME_ID } from '../constants';
import { getConfigPath } from '../paths';
import {
  createDefaultConfig,
  getDefaultAudioTranscription,
  getDefaultHealthMonitor,
  getDefaultLlmConnections,
  getDefaultWorkspaceTools,
  workspaceFromLegacyPath,
} from './defaults';

/**
 * Normalize older `config.json` shapes to the current schema; mutates a copy when needed.
 */
export function migrateConfig(config: AppConfig): AppConfig {
  let migrated = false;
  const newConfig: AppConfig = { ...config } as AppConfig;

  if (!Array.isArray(newConfig.workspaces)) {
    newConfig.workspaces = [];
    migrated = true;
  }

  for (const workspace of newConfig.workspaces) {
    if ((workspace as { themeId?: string }).themeId === undefined) {
      (workspace as { themeId: string }).themeId = newConfig.themeId || FIRST_THEME_ID;
      migrated = true;
    }
  }

  if ((newConfig as { noWorkspaceThemeId?: string }).noWorkspaceThemeId === undefined) {
    (newConfig as { noWorkspaceThemeId: string }).noWorkspaceThemeId = newConfig.themeId || FIRST_THEME_ID;
    migrated = true;
  }

  if ('currentWorkspace' in newConfig && typeof (newConfig as { currentWorkspace?: string }).currentWorkspace === 'string') {
    const oldPath = (newConfig as { currentWorkspace: string }).currentWorkspace;
    if (oldPath && newConfig.workspaces.length === 0) {
      const defaultWorkspace = workspaceFromLegacyPath(oldPath, newConfig.themeId || FIRST_THEME_ID);
      newConfig.workspaces.push(defaultWorkspace);
      newConfig.currentWorkspaceId = defaultWorkspace.id;
    }
    delete (newConfig as { currentWorkspace?: string }).currentWorkspace;
    migrated = true;
  }

  if (newConfig.currentWorkspaceId === undefined) {
    newConfig.currentWorkspaceId = null;
    migrated = true;
  }

  if (!Array.isArray(newConfig.llmConnections) || newConfig.llmConnections.length === 0) {
    (newConfig as { llmConnections: LlmConnectionConfig[] }).llmConnections = getDefaultLlmConnections();
    migrated = true;
  }

  for (const connection of newConfig.llmConnections) {
    if (!connection.id) {
      connection.id = randomUUID();
      migrated = true;
    }
    if (!connection.name) {
      connection.name = connection.provider === 'lmstudio' ? 'LM Studio Connection' : 'OpenAI Connection';
      migrated = true;
    }
    if (!connection.provider) {
      connection.provider = 'openai';
      migrated = true;
    }
    if (connection.baseUrl === undefined) {
      connection.baseUrl = connection.provider === 'lmstudio' ? 'http://127.0.0.1:1234/v1' : '';
      migrated = true;
    }
    if (connection.model === undefined) {
      connection.model = connection.provider === 'lmstudio' ? 'local-model' : 'gpt-4o-mini';
      migrated = true;
    }
    if (typeof connection.contextWindowTokens !== 'number' || Number.isNaN(connection.contextWindowTokens)) {
      connection.contextWindowTokens = inferContextWindowTokens(connection.model, connection.provider);
      migrated = true;
    } else {
      const contextWindowTokens = Math.min(10_000_000, Math.max(1_024, Math.floor(connection.contextWindowTokens)));
      if (contextWindowTokens !== connection.contextWindowTokens) {
        connection.contextWindowTokens = contextWindowTokens;
        migrated = true;
      }
    }
    if (connection.apiKey === undefined) {
      connection.apiKey = connection.provider === 'lmstudio' ? 'lm-studio' : '';
      migrated = true;
    }
    if (connection.reasoningEffort === undefined) {
      connection.reasoningEffort = '';
      migrated = true;
    }
    if (typeof connection.temperature !== 'number' || Number.isNaN(connection.temperature)) {
      connection.temperature = 0;
      migrated = true;
    } else {
      const clamped = Math.min(1, Math.max(0, connection.temperature));
      if (clamped !== connection.temperature) {
        connection.temperature = clamped;
        migrated = true;
      }
    }
    if (connection.parallelToolCalls !== true && connection.parallelToolCalls !== false) {
      connection.parallelToolCalls = false;
      migrated = true;
    }
    if (
      connection.optimizationPreset !== 'generic' &&
      connection.optimizationPreset !== 'qwen' &&
      connection.optimizationPreset !== 'capable'
    ) {
      connection.optimizationPreset = 'generic';
      migrated = true;
    }
    if (typeof connection.maxOutputTokens !== 'number' || Number.isNaN(connection.maxOutputTokens)) {
      connection.maxOutputTokens = 0;
      migrated = true;
    } else {
      const mt = Math.min(200_000, Math.max(0, Math.floor(connection.maxOutputTokens)));
      if (mt !== connection.maxOutputTokens) {
        connection.maxOutputTokens = mt;
        migrated = true;
      }
    }
    if (typeof connection.planRetryAttemptsCount !== 'number' || Number.isNaN(connection.planRetryAttemptsCount)) {
      connection.planRetryAttemptsCount = 2;
      migrated = true;
    } else {
      const attempts = Math.min(20, Math.max(0, Math.floor(connection.planRetryAttemptsCount)));
      if (attempts !== connection.planRetryAttemptsCount) {
        connection.planRetryAttemptsCount = attempts;
        migrated = true;
      }
    }
  }

  if (newConfig.activeLlmConnectionId === undefined) {
    newConfig.activeLlmConnectionId = newConfig.llmConnections[0]?.id ?? 'default-openai';
    migrated = true;
  }

  const hasActiveConnection = newConfig.llmConnections.some((c) => c.id === newConfig.activeLlmConnectionId);
  if (!hasActiveConnection) {
    newConfig.activeLlmConnectionId = newConfig.llmConnections[0]?.id ?? 'default-openai';
    migrated = true;
  }

  if (!newConfig.audioTranscription) {
    newConfig.audioTranscription = getDefaultAudioTranscription();
    migrated = true;
  } else {
    const audio = newConfig.audioTranscription;
    if (!audio.provider) {
      audio.provider = 'openai';
      migrated = true;
    }
    if (audio.baseUrl === undefined) {
      audio.baseUrl = '';
      migrated = true;
    }
    if (!audio.model) {
      audio.model = 'gpt-4o-mini-transcribe';
      migrated = true;
    }
    if (audio.apiKey === undefined) {
      audio.apiKey = '';
      migrated = true;
    }
  }

  const wtRaw = (newConfig as AppConfig & { workspaceTools?: WorkspaceToolsConfig }).workspaceTools;
  if (!wtRaw) {
    (newConfig as AppConfig).workspaceTools = getDefaultWorkspaceTools();
    migrated = true;
  } else {
    const wt = wtRaw;
    if (wt.editToolsMode !== 'standard' && wt.editToolsMode !== 'strict') {
      wt.editToolsMode = 'standard';
      migrated = true;
    }
    if (typeof wt.maxFileReadLines !== 'number' || wt.maxFileReadLines < 50 || wt.maxFileReadLines > 2000) {
      wt.maxFileReadLines = 400;
      migrated = true;
    }
    if (typeof wt.maxSearchResults !== 'number' || wt.maxSearchResults < 1 || wt.maxSearchResults > 200) {
      wt.maxSearchResults = 40;
      migrated = true;
    }
    if (typeof wt.defaultWorkspaceEncoding !== 'string' || !wt.defaultWorkspaceEncoding.trim()) {
      wt.defaultWorkspaceEncoding = 'utf-8';
      migrated = true;
    }
    const allowedNl: WorkspaceToolsConfig['defaultWorkspaceNewline'][] = ['lf', 'crlf', 'preserve'];
    if (!allowedNl.includes(wt.defaultWorkspaceNewline)) {
      wt.defaultWorkspaceNewline = 'lf';
      migrated = true;
    }
  }

  const hm = (newConfig as AppConfig & { healthMonitor?: HealthMonitorConfig }).healthMonitor;
  if (!hm || typeof hm !== 'object') {
    (newConfig as AppConfig).healthMonitor = getDefaultHealthMonitor();
    migrated = true;
  } else {
    const allowed: HealthMonitorConfig['logLevel'][] = ['debug', 'info', 'warning', 'error'];
    if (!allowed.includes(hm.logLevel)) {
      hm.logLevel = 'info';
      migrated = true;
    }
    if (typeof hm.metricsEnabled !== 'boolean') {
      hm.metricsEnabled = false;
      migrated = true;
    }
  }

  return migrated ? newConfig : config;
}

/** Async load; creates default file on first run. */
export async function loadConfig(): Promise<AppConfig> {
  const configPath = getConfigPath();
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(raw) as AppConfig;
    const migrated = migrateConfig(config);
    if (migrated !== config) {
      await saveConfig(migrated);
    }
    return migrated;
  } catch {
    const defaultConfig = createDefaultConfig();
    await saveConfig(defaultConfig);
    return defaultConfig;
  }
}

export async function saveConfig(config: AppConfig): Promise<void> {
  const configPath = getConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

/** Sync read for menu “recent” without async file IO in the menu builder path. */
export function loadConfigSync(): AppConfig {
  const configPath = getConfigPath();
  try {
    const raw = syncFs.readFileSync(configPath, 'utf-8');
    return migrateConfig(JSON.parse(raw) as AppConfig);
  } catch {
    return createDefaultConfig();
  }
}
