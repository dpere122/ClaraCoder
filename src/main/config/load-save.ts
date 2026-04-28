import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path = require('path');
const syncFs = require('fs');
import type {
  AppConfig,
  HealthMonitorConfig,
  LlamaCppManaged,
  LlmConnectionConfig,
  LlmModelProfile,
  LlmProviderConfig,
  WorkspaceToolsConfig,
} from '../../shared';
import {
  defaultLlamaCppManaged,
  findLlmModelLocation,
  inferContextWindowTokens,
  isLegacyLlamaCppManagedShape,
  migrateLegacyLlamaCppManagedToCommands,
  type ShellQuotingPlatform,
} from '../../shared';
import { FIRST_THEME_ID } from '../constants';
import { getConfigPath } from '../paths';
import {
  createDefaultConfig,
  getDefaultAudioTranscription,
  getDefaultHealthMonitor,
  getDefaultLlmProviders,
  getDefaultWorkspaceTools,
  workspaceFromLegacyPath,
} from './defaults';

function legacyFlatRowToProvider(row: LlmConnectionConfig): LlmProviderConfig {
  const {
    provider,
    baseUrl,
    apiKey,
    id: modelId,
    name: rowName,
    model: apiModel,
    contextWindowTokens,
    reasoningEffort,
    thinkingMode,
    samplingPreset,
    topP,
    topK,
    minP,
    presencePenalty,
    repeatPenalty,
    architectureHint,
    temperature,
    parallelToolCalls,
    optimizationPreset,
    maxOutputTokens,
    planRetryAttemptsCount,
  } = row;
  const modelProfile: LlmModelProfile = {
    id: modelId,
    name: rowName,
    model: apiModel,
    contextWindowTokens,
    reasoningEffort,
    thinkingMode,
    samplingPreset,
    topP,
    topK,
    minP,
    presencePenalty,
    repeatPenalty,
    architectureHint,
    temperature,
    parallelToolCalls,
    optimizationPreset,
    maxOutputTokens,
    planRetryAttemptsCount,
  };
  return {
    id: randomUUID(),
    name: rowName,
    provider,
    baseUrl,
    apiKey,
    models: [modelProfile],
  };
}

function normalizeLlmModelProfile(model: LlmModelProfile, provider: LlmProviderConfig): boolean {
  let migrated = false;
  if (!model.id) {
    model.id = randomUUID();
    migrated = true;
  }
  if (!model.name) {
    model.name = model.model || 'Model';
    migrated = true;
  }
  if (model.model === undefined || model.model === '') {
    model.model =
      provider.provider === 'lmstudio' || provider.provider === 'llamacpp' ? 'local-model' : 'gpt-4o-mini';
    migrated = true;
  }
  if (typeof model.contextWindowTokens !== 'number' || Number.isNaN(model.contextWindowTokens)) {
    model.contextWindowTokens = inferContextWindowTokens(model.model, provider.provider);
    migrated = true;
  } else {
    const contextWindowTokens = Math.min(10_000_000, Math.max(1_024, Math.floor(model.contextWindowTokens)));
    if (contextWindowTokens !== model.contextWindowTokens) {
      model.contextWindowTokens = contextWindowTokens;
      migrated = true;
    }
  }
  if (model.reasoningEffort === undefined) {
    model.reasoningEffort = '';
    migrated = true;
  } else {
    const raw = String(model.reasoningEffort).trim().toLowerCase();
    const allowed: Array<NonNullable<LlmModelProfile['reasoningEffort']>> = [
      '',
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'on',
      'off',
    ];
    const normalized = (allowed as string[]).includes(raw) ? (raw as LlmModelProfile['reasoningEffort']) : '';
    if (model.reasoningEffort !== normalized) {
      model.reasoningEffort = normalized;
      migrated = true;
    }
  }
  if (typeof model.temperature !== 'number' || Number.isNaN(model.temperature)) {
    model.temperature = 0;
    migrated = true;
  } else {
    const clamped = Math.min(1, Math.max(0, model.temperature));
    if (clamped !== model.temperature) {
      model.temperature = clamped;
      migrated = true;
    }
  }
  if (model.parallelToolCalls !== true && model.parallelToolCalls !== false) {
    model.parallelToolCalls = false;
    migrated = true;
  }
  if (
    model.optimizationPreset !== 'generic' &&
    model.optimizationPreset !== 'qwen' &&
    model.optimizationPreset !== 'capable' &&
    model.optimizationPreset !== 'gemma'
  ) {
    model.optimizationPreset = 'generic';
    migrated = true;
  }
  if (model.thinkingMode === undefined) {
    model.thinkingMode = 'default';
    migrated = true;
  } else {
    const tm = String(model.thinkingMode).trim().toLowerCase();
    const allowedTm: LlmModelProfile['thinkingMode'][] = ['default', 'on', 'off'];
    const ntm = (allowedTm as string[]).includes(tm) ? (tm as LlmModelProfile['thinkingMode']) : 'default';
    if (model.thinkingMode !== ntm) {
      model.thinkingMode = ntm;
      migrated = true;
    }
  }
  if (model.samplingPreset === undefined) {
    model.samplingPreset = 'provider-default';
    migrated = true;
  } else {
    const sp = String(model.samplingPreset).trim().toLowerCase();
    const allowedSp: LlmModelProfile['samplingPreset'][] = ['provider-default', 'gemma-recommended', 'custom'];
    const nsp = (allowedSp as string[]).includes(sp) ? (sp as LlmModelProfile['samplingPreset']) : 'provider-default';
    if (model.samplingPreset !== nsp) {
      model.samplingPreset = nsp;
      migrated = true;
    }
  }
  if (model.architectureHint === undefined) {
    model.architectureHint = 'auto';
    migrated = true;
  } else {
    const ah = String(model.architectureHint).trim().toLowerCase();
    const allowedAh: LlmModelProfile['architectureHint'][] = ['auto', 'dense'];
    const nah = (allowedAh as string[]).includes(ah) ? (ah as LlmModelProfile['architectureHint']) : 'auto';
    if (model.architectureHint !== nah) {
      model.architectureHint = nah;
      migrated = true;
    }
  }
  if (model.topP !== undefined && model.topP !== null) {
    const tp = Number(model.topP);
    if (Number.isNaN(tp)) {
      delete model.topP;
      migrated = true;
    } else {
      const c = Math.min(1, Math.max(0, tp));
      if (c !== model.topP) {
        model.topP = c;
        migrated = true;
      }
    }
  }
  if (model.topK !== undefined && model.topK !== null) {
    const tk = Math.floor(Number(model.topK));
    if (Number.isNaN(tk)) {
      delete model.topK;
      migrated = true;
    } else {
      const c = Math.min(256, Math.max(1, tk));
      if (c !== model.topK) {
        model.topK = c;
        migrated = true;
      }
    }
  }
  if (model.minP !== undefined && model.minP !== null) {
    const mp = Number(model.minP);
    if (Number.isNaN(mp)) {
      delete model.minP;
      migrated = true;
    } else {
      const c = Math.min(1, Math.max(0, mp));
      if (c !== model.minP) {
        model.minP = c;
        migrated = true;
      }
    }
  }
  if (model.presencePenalty !== undefined && model.presencePenalty !== null) {
    const pp = Number(model.presencePenalty);
    if (Number.isNaN(pp)) {
      delete model.presencePenalty;
      migrated = true;
    } else {
      const c = Math.min(2, Math.max(-2, pp));
      if (c !== model.presencePenalty) {
        model.presencePenalty = c;
        migrated = true;
      }
    }
  }
  if (model.repeatPenalty !== undefined && model.repeatPenalty !== null) {
    const rp = Number(model.repeatPenalty);
    if (Number.isNaN(rp)) {
      delete model.repeatPenalty;
      migrated = true;
    } else {
      const c = Math.min(4, Math.max(0.01, rp));
      if (c !== model.repeatPenalty) {
        model.repeatPenalty = c;
        migrated = true;
      }
    }
  }
  if (typeof model.maxOutputTokens !== 'number' || Number.isNaN(model.maxOutputTokens)) {
    model.maxOutputTokens = 0;
    migrated = true;
  } else {
    const mt = Math.min(200_000, Math.max(0, Math.floor(model.maxOutputTokens)));
    if (mt !== model.maxOutputTokens) {
      model.maxOutputTokens = mt;
      migrated = true;
    }
  }
  if (typeof model.planRetryAttemptsCount !== 'number' || Number.isNaN(model.planRetryAttemptsCount)) {
    model.planRetryAttemptsCount = 2;
    migrated = true;
  } else {
    const attempts = Math.min(20, Math.max(0, Math.floor(model.planRetryAttemptsCount)));
    if (attempts !== model.planRetryAttemptsCount) {
      model.planRetryAttemptsCount = attempts;
      migrated = true;
    }
  }
  if (provider.provider === 'llamacpp') {
    if (normalizeLlamaCppManagedField(model)) {
      migrated = true;
    }
  } else if (model.llamaCppManaged !== undefined) {
    delete model.llamaCppManaged;
    migrated = true;
  }
  return migrated;
}

function normalizeLlamaCppManagedField(model: LlmModelProfile): boolean {
  const base = defaultLlamaCppManaged();
  const quotingPlatform: ShellQuotingPlatform = process.platform === 'win32' ? 'win32' : 'posix';

  if (model.llamaCppManaged === undefined || typeof model.llamaCppManaged !== 'object') {
    model.llamaCppManaged = { ...base };
    return true;
  }

  const raw = model.llamaCppManaged as unknown as Record<string, unknown>;

  if (isLegacyLlamaCppManagedShape(raw)) {
    model.llamaCppManaged = migrateLegacyLlamaCppManagedToCommands(raw, quotingPlatform);
    return true;
  }

  let migrated = false;
  const chatRunCommand = typeof raw.chatRunCommand === 'string' ? raw.chatRunCommand : '';
  const embeddingRunCommand = typeof raw.embeddingRunCommand === 'string' ? raw.embeddingRunCommand : '';
  if (typeof raw.chatRunCommand !== 'string' || typeof raw.embeddingRunCommand !== 'string') {
    migrated = true;
  }
  const next: LlamaCppManaged = { chatRunCommand, embeddingRunCommand };
  if (typeof raw.huggingFaceToken === 'string') {
    next.huggingFaceToken = raw.huggingFaceToken;
  }
  model.llamaCppManaged = next;
  return migrated;
}

function normalizeLlmProvidersTree(providers: LlmProviderConfig[]): boolean {
  let migrated = false;
  for (const p of providers) {
    if (!p.id) {
      p.id = randomUUID();
      migrated = true;
    }
    if (!p.name) {
      p.name =
        p.provider === 'lmstudio' ? 'LM Studio' : p.provider === 'llamacpp' ? 'llama.cpp' : 'OpenAI';
      migrated = true;
    }
    if (p.provider !== 'openai' && p.provider !== 'lmstudio' && p.provider !== 'llamacpp') {
      p.provider = 'openai';
      migrated = true;
    }
    if (p.baseUrl === undefined) {
      p.baseUrl =
        p.provider === 'lmstudio'
          ? 'http://127.0.0.1:1234/v1'
          : p.provider === 'llamacpp'
            ? 'http://127.0.0.1:8080/v1'
            : '';
      migrated = true;
    }
    if (p.apiKey === undefined) {
      p.apiKey = p.provider === 'lmstudio' ? 'lm-studio' : '';
      migrated = true;
    }
    if (!Array.isArray(p.models) || p.models.length === 0) {
      const mid =
        p.provider === 'lmstudio' || p.provider === 'llamacpp' ? 'local-model' : 'gpt-4o-mini';
      p.models = [
        {
          id: randomUUID(),
          name: 'Default',
          model: mid,
          contextWindowTokens: inferContextWindowTokens(mid, p.provider),
          reasoningEffort: '',
          thinkingMode: 'default',
          samplingPreset: 'provider-default',
          architectureHint: 'auto',
          temperature: 0,
          parallelToolCalls: false,
          optimizationPreset: 'generic',
          maxOutputTokens: 0,
          planRetryAttemptsCount: 2,
        },
      ];
      migrated = true;
    }
    for (const m of p.models) {
      if (normalizeLlmModelProfile(m, p)) {
        migrated = true;
      }
    }
  }
  return migrated;
}

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

  const rawLlm = newConfig as unknown as {
    llmConnections?: LlmConnectionConfig[];
    llmProviders?: LlmProviderConfig[];
    activeLlmConnectionId?: string;
    activeLlmModelId?: string;
  };

  const legacyConnections = Array.isArray(rawLlm.llmConnections) ? rawLlm.llmConnections : [];
  const hasProviders = Array.isArray(rawLlm.llmProviders) && rawLlm.llmProviders.length > 0;

  if (legacyConnections.length > 0 && !hasProviders) {
    newConfig.llmProviders = legacyConnections.map((row) => legacyFlatRowToProvider(row));
    migrated = true;
  }
  if (!Array.isArray(newConfig.llmProviders) || newConfig.llmProviders.length === 0) {
    newConfig.llmProviders = getDefaultLlmProviders();
    migrated = true;
  }

  if (normalizeLlmProvidersTree(newConfig.llmProviders)) {
    migrated = true;
  }

  if (newConfig.activeLlmModelId === undefined || newConfig.activeLlmModelId === '') {
    const legacyActive =
      typeof rawLlm.activeLlmConnectionId === 'string' && rawLlm.activeLlmConnectionId
        ? rawLlm.activeLlmConnectionId
        : '';
    newConfig.activeLlmModelId =
      legacyActive && findLlmModelLocation(newConfig.llmProviders, legacyActive)
        ? legacyActive
        : (newConfig.llmProviders[0]?.models[0]?.id ?? 'default-openai');
    migrated = true;
  }

  delete (newConfig as { llmConnections?: unknown }).llmConnections;
  delete (newConfig as { activeLlmConnectionId?: unknown }).activeLlmConnectionId;

  if (!findLlmModelLocation(newConfig.llmProviders, newConfig.activeLlmModelId)) {
    newConfig.activeLlmModelId = newConfig.llmProviders[0]?.models[0]?.id ?? 'default-openai';
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
    const orchRaw = (wt as unknown as { orchestratedMode?: unknown }).orchestratedMode;
    if (typeof orchRaw === 'string') {
      const s = orchRaw.trim().toLowerCase();
      wt.orchestratedMode = s === 'true' || s === '1' || s === 'yes' || s === 'on';
      migrated = true;
    } else if (typeof orchRaw !== 'boolean') {
      wt.orchestratedMode = false;
      migrated = true;
    }
    const phasedRaw = (wt as unknown as { outerPhasedCodingCycle?: unknown }).outerPhasedCodingCycle;
    if (typeof phasedRaw === 'string') {
      const s = phasedRaw.trim().toLowerCase();
      wt.outerPhasedCodingCycle = s === 'true' || s === '1' || s === 'yes' || s === 'on';
      migrated = true;
    } else if (typeof phasedRaw !== 'boolean') {
      wt.outerPhasedCodingCycle = false;
      migrated = true;
    }
    const overlayRaw = (wt as unknown as { allowStagingOverlayCommands?: unknown }).allowStagingOverlayCommands;
    if (typeof overlayRaw === 'string') {
      const s = overlayRaw.trim().toLowerCase();
      wt.allowStagingOverlayCommands = s === 'true' || s === '1' || s === 'yes' || s === 'on';
      migrated = true;
    } else if (typeof overlayRaw !== 'boolean') {
      wt.allowStagingOverlayCommands = false;
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
