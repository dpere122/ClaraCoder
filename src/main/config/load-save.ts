import { createHash, randomUUID } from 'crypto';
import { normalizeScreenshotRetention } from '../../shared/screenshot-retention';
import { promises as fs } from 'fs';
import path = require('path');
const syncFs = require('fs');
import type {
  AppConfig,
  AudioTranscriptionConfig,
  HealthMonitorConfig,
  LlamaCppManaged,
  LlmConnectionConfig,
  LlmModelProfile,
  LlmProviderConfig,
  ContextCompressionConfig,
  McpHttpAuth,
  McpHttpTransport,
  McpOAuthTokens,
  McpSecretEntry,
  McpServerConfig,
  McpServerTransport,
  McpToolDecision,
  McpTrust,
  SecretStorageMode,
  WorkspaceToolsConfig,
} from '../../shared';
import {
  DEFAULT_MANAGED_LLAMA_CHAT_RUN_COMMAND,
  DEFAULT_MANAGED_LLAMA_SOURCE_NAME,
  uniqueManagedLlamaSourceName,
  defaultLlamaCppManaged,
  DEFAULT_KOKORO_TTS_VOICE,
  DEFAULT_OPENAI_TRANSCRIBE_MODEL,
  DEFAULT_OPENAI_TTS_BASE_URL,
  DEFAULT_OPENAI_TTS_VOICE,
  DEFAULT_TTS_PROVIDER,
  DEFAULT_WHISPER_MODEL,
  defaultLlmModelId,
  findLlmModelLocation,
  inferContextWindowTokens,
  isLegacyLlamaCppManagedShape,
  migrateLegacyLlamaCppManagedToCommands,
  normalizeChatContainerSize,
  normalizeChatThinkingDisplay,
  normalizeMonacoWorkspaceEditorSettings,
  normalizeWebSearchEngines,
  normalizeWorkspaceMonacoScrollByWorkspaceId,
  normalizeWorkspaceOpenTabsByWorkspaceId,
  getDefaultContextCompression,
  maxContextCompressionTarget,
  TTS_SPEECH_SPEED_DEFAULT,
  TTS_SPEECH_SPEED_MAX,
  TTS_SPEECH_SPEED_MIN,
  type ShellQuotingPlatform,
} from '../../shared';
import {
  PINNED_LLAMA_CPP_LOCAL_PROVIDER_ID,
  PINNED_LM_STUDIO_PROVIDER_ID,
  PINNED_LLAMA_SERVER_URL_PROVIDER_ID,
  PINNED_OPENROUTER_PROVIDER_ID,
  PINNED_ANTHROPIC_PROVIDER_ID,
  OPENROUTER_DEFAULT_BASE_URL,
} from '../../shared';
import {
  coerceSecretValue,
  isSecretValue,
  redactSecretsInJson,
  SecretValue,
  unwrapSecret,
} from '../../shared/types/app-config';
import {
  applyTutorialTransition,
  isTutorialProgressSupported,
  normalizeTutorialProgress,
  type TutorialProgress,
  type TutorialTransition,
} from '../../shared/types/tutorial';
import { FIRST_THEME_ID } from '../constants';
import { THEME_ID_PATTERN } from '../../shared/theme/theme-document';
import { LEGACY_THEME_ID_MAP } from '../../shared/theme/builtin';
import { getConfigPath } from '../paths';
import {
  APP_CONFIG_SCHEMA_VERSION,
  createDefaultConfig,
  createPinnedLmStudioProvider,
  createPinnedLlamaServerUrlProvider,
  createPinnedLocalManagedLlamaProvider,
  createPinnedOpenRouterProvider,
  createPinnedAnthropicProvider,
  getDefaultAudioTranscription,
  getDefaultHealthMonitor,
  getDefaultLlmProviders,
  getDefaultModelManagerConfig,
  getDefaultWorkspaceTools,
  workspaceFromLegacyPath,
} from './defaults';

/** Disk marker for OS-keychain–encrypted secret payloads (Electron safeStorage). */
const SECRET_DISK_PREFIX = 'clara-secret:v1:';

let keychainFallbackWarned = false;

type SafeStorageLike = {
  isEncryptionAvailable: () => boolean;
  encryptString: (plain: string) => Buffer;
  decryptString: (blob: Buffer) => string;
};

/** Opt-in OS keychain via Electron safeStorage; no hard native deps if unavailable. */
function tryGetSafeStorage(): SafeStorageLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { safeStorage?: SafeStorageLike };
    const ss = electron?.safeStorage;
    if (
      ss &&
      typeof ss.isEncryptionAvailable === 'function' &&
      typeof ss.encryptString === 'function' &&
      typeof ss.decryptString === 'function'
    ) {
      return ss;
    }
  } catch {
    // Vitest / non-Electron hosts: fall back to mode-0600 plaintext.
  }
  return null;
}

function warnKeychainFallbackOnce(): void {
  if (keychainFallbackWarned) {
    return;
  }
  keychainFallbackWarned = true;
  console.warn(
    '[config] OS keychain encryption unavailable; persisting secrets as plaintext in mode-0600 config file.',
  );
}

/** How {@link encryptSecretForDisk} will store secrets on this host right now. */
export function secretStorageMode(): SecretStorageMode {
  return tryGetSafeStorage()?.isEncryptionAvailable() ? 'keychain' : 'plaintext';
}

function encryptSecretForDisk(plain: string): string {
  if (!plain) {
    return '';
  }
  const ss = tryGetSafeStorage();
  if (ss?.isEncryptionAvailable()) {
    try {
      return `${SECRET_DISK_PREFIX}${ss.encryptString(plain).toString('base64')}`;
    } catch {
      warnKeychainFallbackOnce();
      return plain;
    }
  }
  warnKeychainFallbackOnce();
  return plain;
}

function decryptSecretFromDisk(stored: string): string {
  if (!stored.startsWith(SECRET_DISK_PREFIX)) {
    return stored;
  }
  const ss = tryGetSafeStorage();
  if (!ss?.isEncryptionAvailable()) {
    // Keychain down: do NOT strip the prefix and treat base64 ciphertext as a
    // credential — refuse the secret and warn once.
    warnKeychainFallbackOnce();
    return '';
  }
  try {
    const blob = Buffer.from(stored.slice(SECRET_DISK_PREFIX.length), 'base64');
    return ss.decryptString(blob);
  } catch {
    warnKeychainFallbackOnce();
    return '';
  }
}

/** Decrypt disk form (if any) and wrap as {@link SecretValue}; never drops material. */
function decryptAndWrapSecret(value: unknown): SecretValue<string> {
  if (isSecretValue(value)) {
    const inner = value.unwrap();
    if (inner.startsWith(SECRET_DISK_PREFIX)) {
      return SecretValue.of(decryptSecretFromDisk(inner));
    }
    return value;
  }
  if (typeof value === 'string') {
    return SecretValue.of(decryptSecretFromDisk(value));
  }
  return coerceSecretValue(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeMcpSecretEntries(raw: unknown): { entries: McpSecretEntry[]; migrated: boolean } {
  if (!Array.isArray(raw)) {
    return { entries: [], migrated: raw != null };
  }
  const entries: McpSecretEntry[] = [];
  let migrated = false;
  for (const item of raw) {
    const row = asRecord(item);
    if (!row) {
      migrated = true;
      continue;
    }
    const key = typeof row.key === 'string' ? row.key.trim() : '';
    if (!key) {
      migrated = true;
      continue;
    }
    const value = decryptAndWrapSecret(row.value);
    if (!isSecretValue(row.value) || unwrapSecret(row.value) !== value.unwrap()) {
      migrated = true;
    }
    entries.push({ key, value });
  }
  return { entries, migrated };
}

function normalizeMcpOAuth(raw: unknown): { oauth: McpOAuthTokens | null; migrated: boolean } {
  if (raw == null) {
    return { oauth: null, migrated: false };
  }
  const row = asRecord(raw);
  if (!row) {
    return { oauth: null, migrated: true };
  }
  const accessToken = decryptAndWrapSecret(row.accessToken);
  const refreshToken = decryptAndWrapSecret(row.refreshToken);
  const clientSecret = decryptAndWrapSecret(row.clientSecret);
  const expiresAt = typeof row.expiresAt === 'number' && Number.isFinite(row.expiresAt) ? row.expiresAt : 0;
  const clientId = typeof row.clientId === 'string' ? row.clientId : '';
  const scopes = Array.isArray(row.scopes) ? row.scopes.filter((s): s is string => typeof s === 'string' && !!s.trim()) : [];
  // Missing on tokens saved before URL binding; Python then treats them as not usable.
  const serverUrl = typeof row.serverUrl === 'string' ? row.serverUrl.trim() : '';
  // Missing on older sign-ins; those tokens are simply not refreshed.
  const tokenEndpoint = typeof row.tokenEndpoint === 'string' ? row.tokenEndpoint.trim() : '';
  const resource = typeof row.resource === 'string' ? row.resource.trim() : '';
  const tokenAuthMethod = typeof row.tokenAuthMethod === 'string' ? row.tokenAuthMethod.trim() : '';
  let migrated =
    expiresAt !== row.expiresAt ||
    clientId !== row.clientId ||
    serverUrl !== row.serverUrl ||
    tokenEndpoint !== row.tokenEndpoint ||
    resource !== row.resource ||
    tokenAuthMethod !== row.tokenAuthMethod ||
    scopes.length !== (Array.isArray(row.scopes) ? row.scopes.length : 0);
  if (!isSecretValue(row.accessToken) || unwrapSecret(row.accessToken) !== accessToken.unwrap()) {
    migrated = true;
  }
  if (!isSecretValue(row.refreshToken) || unwrapSecret(row.refreshToken) !== refreshToken.unwrap()) {
    migrated = true;
  }
  if (!isSecretValue(row.clientSecret) || unwrapSecret(row.clientSecret) !== clientSecret.unwrap()) {
    migrated = true;
  }
  if (!accessToken.unwrap() && !refreshToken.unwrap() && !clientId) {
    return { oauth: null, migrated: true };
  }
  return {
    oauth: {
      accessToken,
      refreshToken,
      expiresAt,
      clientId,
      clientSecret,
      scopes,
      serverUrl,
      tokenEndpoint,
      resource,
      tokenAuthMethod,
    },
    migrated,
  };
}

function normalizeToolDecisions(raw: unknown): { decisions: Record<string, McpToolDecision>; migrated: boolean } {
  const row = asRecord(raw);
  if (raw == null) {
    return { decisions: {}, migrated: false };
  }
  if (!row) {
    return { decisions: {}, migrated: true };
  }
  const decisions: Record<string, McpToolDecision> = {};
  let migrated = false;
  for (const [key, value] of Object.entries(row)) {
    const name = key.trim();
    if (!name || (value !== 'allow' && value !== 'deny')) {
      migrated = true;
      continue;
    }
    decisions[name] = value;
  }
  return { decisions, migrated };
}

function normalizeOneMcpServer(raw: unknown): { server: McpServerConfig | null; migrated: boolean } {
  const row = asRecord(raw);
  if (!row) {
    return { server: null, migrated: true };
  }
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  if (!id) {
    return { server: null, migrated: true };
  }
  let migrated = false;
  const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : 'MCP server';
  if (name !== row.name) {
    migrated = true;
  }
  const enabled = typeof row.enabled === 'boolean' ? row.enabled : false;
  if (enabled !== row.enabled) {
    migrated = true;
  }
  const trust: McpTrust = row.trust === 'allow-all' ? 'allow-all' : 'ask';
  if (trust !== row.trust) {
    migrated = true;
  }
  const transport: McpServerTransport = row.transport === 'http' ? 'http' : 'stdio';
  if (transport !== row.transport) {
    migrated = true;
  }
  const command = typeof row.command === 'string' ? row.command : '';
  if (command !== row.command) {
    migrated = true;
  }
  const args = Array.isArray(row.args) ? row.args.filter((a): a is string => typeof a === 'string') : [];
  if (!Array.isArray(row.args) || args.length !== row.args.length) {
    migrated = true;
  }
  const env = normalizeMcpSecretEntries(row.env);
  const url = typeof row.url === 'string' ? row.url.trim() : '';
  if (url !== row.url) {
    migrated = true;
  }
  const httpTransport: McpHttpTransport = row.httpTransport === 'sse' ? 'sse' : 'streamable';
  if (httpTransport !== row.httpTransport) {
    migrated = true;
  }
  const httpAuth: McpHttpAuth = row.httpAuth === 'headers' || row.httpAuth === 'oauth' ? row.httpAuth : 'none';
  if (httpAuth !== row.httpAuth) {
    migrated = true;
  }
  const headers = normalizeMcpSecretEntries(row.headers);
  const oauth = normalizeMcpOAuth(row.oauth);
  const decisions = normalizeToolDecisions(row.toolDecisions);
  migrated =
    migrated || env.migrated || headers.migrated || oauth.migrated || decisions.migrated;
  const server: McpServerConfig = {
    id,
    name,
    enabled,
    trust,
    transport,
    command,
    args,
    env: env.entries,
    url,
    httpTransport,
    httpAuth,
    headers: headers.entries,
    oauth: oauth.oauth,
    toolDecisions: decisions.decisions,
  };
  if (row.trustTouched === true) {
    server.trustTouched = true;
  }
  if (row.toolDecisionsTouched === true) {
    server.toolDecisionsTouched = true;
  }
  if (row.oauthTouched === true) {
    server.oauthTouched = true;
  }
  return { server, migrated };
}

/** Fill missing MCP config and wrap secrets. Drops entries without an id. */
function normalizeMcpServers(raw: unknown): { servers: McpServerConfig[]; migrated: boolean } {
  if (raw == null) {
    return { servers: [], migrated: true };
  }
  if (!Array.isArray(raw)) {
    return { servers: [], migrated: true };
  }
  const servers: McpServerConfig[] = [];
  let migrated = false;
  const seen = new Set<string>();
  for (const item of raw) {
    const normalized = normalizeOneMcpServer(item);
    if (!normalized.server) {
      migrated = true;
      continue;
    }
    if (seen.has(normalized.server.id)) {
      migrated = true;
      continue;
    }
    seen.add(normalized.server.id);
    if (normalized.migrated) {
      migrated = true;
    }
    servers.push(normalized.server);
  }
  return { servers, migrated };
}

function encryptMcpSecretEntries(entries: McpSecretEntry[]): Array<{ key: string; value: string }> {
  return entries.map((entry) => ({
    key: entry.key,
    value: encryptSecretForDisk(unwrapSecret(entry.value)),
  }));
}

function encryptMcpOAuth(oauth: McpOAuthTokens | null): Record<string, unknown> | null {
  if (!oauth) {
    return null;
  }
  return {
    accessToken: encryptSecretForDisk(unwrapSecret(oauth.accessToken)),
    refreshToken: encryptSecretForDisk(unwrapSecret(oauth.refreshToken)),
    expiresAt: oauth.expiresAt,
    clientId: oauth.clientId,
    clientSecret: encryptSecretForDisk(unwrapSecret(oauth.clientSecret)),
    scopes: oauth.scopes,
    serverUrl: oauth.serverUrl ?? '',
    tokenEndpoint: oauth.tokenEndpoint ?? '',
    resource: oauth.resource ?? '',
    tokenAuthMethod: oauth.tokenAuthMethod ?? '',
  };
}

/** Disk copy of one server: secrets encrypted, merge flags removed. */
function mcpServerForDisk(server: McpServerConfig): Record<string, unknown> {
  return {
    id: server.id,
    name: server.name,
    enabled: server.enabled,
    trust: server.trust,
    transport: server.transport,
    command: server.command,
    args: server.args,
    env: encryptMcpSecretEntries(server.env ?? []),
    url: server.url,
    httpTransport: server.httpTransport,
    httpAuth: server.httpAuth,
    headers: encryptMcpSecretEntries(server.headers ?? []),
    oauth: encryptMcpOAuth(server.oauth),
    toolDecisions: server.toolDecisions ?? {},
  };
}

function exposeMcpSecretEntries(entries: McpSecretEntry[]): void {
  for (const entry of entries) {
    (entry as { value: string | SecretValue<string> }).value = unwrapSecret(entry.value);
  }
}

function exposeMcpServers(servers: McpServerConfig[] | undefined): void {
  for (const server of servers ?? []) {
    exposeMcpSecretEntries(server.env ?? []);
    exposeMcpSecretEntries(server.headers ?? []);
    if (server.oauth) {
      const oauth = server.oauth as {
        accessToken: string | SecretValue<string>;
        refreshToken: string | SecretValue<string>;
        clientSecret: string | SecretValue<string>;
      };
      oauth.accessToken = unwrapSecret(server.oauth.accessToken);
      oauth.refreshToken = unwrapSecret(server.oauth.refreshToken);
      oauth.clientSecret = unwrapSecret(server.oauth.clientSecret);
    }
    delete server.trustTouched;
    delete server.toolDecisionsTouched;
    delete server.oauthTouched;
  }
}

type McpMergeFlags = { trustTouched: boolean; toolDecisionsTouched: boolean; oauthTouched: boolean };

function mcpMergeFlags(servers: McpServerConfig[] | undefined): Map<string, McpMergeFlags> {
  const flags = new Map<string, McpMergeFlags>();
  for (const server of servers ?? []) {
    if (!server?.id) {
      continue;
    }
    flags.set(server.id, {
      trustTouched: server.trustTouched === true,
      toolDecisionsTouched: server.toolDecisionsTouched === true,
      oauthTouched: server.oauthTouched === true,
    });
  }
  return flags;
}

/**
 * Keep chat-time trust, per-tool decisions, and OAuth tokens on disk when Settings
 * applies an older snapshot that did not edit those fields.
 */
function mergeMcpServers(
  disk: McpServerConfig[],
  client: McpServerConfig[],
  flags: Map<string, McpMergeFlags>,
): McpServerConfig[] {
  const diskById = new Map(disk.map((server) => [server.id, server]));
  return client.map((entry) => {
    const prev = diskById.get(entry.id);
    const touch = flags.get(entry.id);
    const next: McpServerConfig = {
      ...entry,
      trust: touch?.trustTouched || !prev ? entry.trust : prev.trust,
      toolDecisions: touch?.toolDecisionsTouched || !prev ? entry.toolDecisions : prev.toolDecisions,
      oauth: touch?.oauthTouched || !prev ? entry.oauth : prev.oauth,
    };
    delete next.trustTouched;
    delete next.toolDecisionsTouched;
    delete next.oauthTouched;
    return next;
  });
}

/**
 * Re-expose secrets as plain strings for IPC/renderer consumers that check
 * `typeof x === 'string'` while still allowing in-memory {@link SecretValue} during migrate/save.
 */
function exposeSecretsForConsumers(config: AppConfig): AppConfig {
  for (const p of config.llmProviders ?? []) {
    (p as { apiKey: string | SecretValue<string> }).apiKey = unwrapSecret(p.apiKey);
  }
  if (config.audioTranscription) {
    const audio = config.audioTranscription as {
      apiKey: string | SecretValue<string>;
      ttsApiKey?: string | SecretValue<string>;
    };
    audio.apiKey = unwrapSecret(audio.apiKey);
    if (audio.ttsApiKey !== undefined) {
      audio.ttsApiKey = unwrapSecret(audio.ttsApiKey);
    }
  }
  if (config.modelManager) {
    (config.modelManager as { huggingFaceToken: string | SecretValue<string> }).huggingFaceToken =
      unwrapSecret(config.modelManager.huggingFaceToken);
  }
  exposeMcpServers(config.mcpServers);
  return config;
}

/** Build a JSON-serializable copy with secrets encrypted (or plaintext fallback). */
function serializeConfigForDisk(config: AppConfig): Record<string, unknown> {
  const providers = (config.llmProviders ?? []).map((p) => ({
    ...p,
    // The Claude key lives in its own keychain file (anthropic-key-store), never in config.json.
    apiKey: p.provider === 'anthropic' ? '' : encryptSecretForDisk(unwrapSecret(p.apiKey)),
    models: p.models,
  }));
  const audio = config.audioTranscription
    ? {
        ...config.audioTranscription,
        apiKey: encryptSecretForDisk(unwrapSecret(config.audioTranscription.apiKey)),
        ttsApiKey: encryptSecretForDisk(unwrapSecret(config.audioTranscription.ttsApiKey)),
      }
    : config.audioTranscription;
  const modelManager = config.modelManager
    ? {
        ...config.modelManager,
        huggingFaceToken: encryptSecretForDisk(unwrapSecret(config.modelManager.huggingFaceToken)),
      }
    : config.modelManager;
  return {
    ...config,
    llmProviders: providers,
    audioTranscription: audio,
    modelManager,
    mcpServers: (config.mcpServers ?? []).map((server) => mcpServerForDisk(server)),
  };
}

async function chmod600BestEffort(filePath: string): Promise<void> {
  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    // Best-effort on platforms that ignore mode bits.
  }
}

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
    embeddingsModel,
    embeddingsBaseUrl,
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
  };
  const embBase = (embeddingsBaseUrl ?? '').trim();
  return {
    id: randomUUID(),
    name: rowName,
    provider,
    baseUrl,
    apiKey,
    ...(typeof embeddingsModel === 'string' && embeddingsModel.trim()
      ? { embeddingsModel: embeddingsModel.trim() }
      : {}),
    ...(embBase ? { embeddingsBaseUrl: embBase } : {}),
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
    const fallback = defaultLlmModelId(provider.provider);
    if (model.model !== fallback) {
      model.model = fallback;
      migrated = true;
    }
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
      'max',
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
  if (typeof model.parallelToolCalls !== 'boolean') {
    model.parallelToolCalls = true;
    migrated = true;
  }
  if (
    model.optimizationPreset !== 'generic' &&
    model.optimizationPreset !== 'qwen' &&
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
  if (Object.prototype.hasOwnProperty.call(model, 'planRetryAttemptsCount')) {
    delete (model as LlmModelProfile & { planRetryAttemptsCount?: unknown }).planRetryAttemptsCount;
    migrated = true;
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
  let chatRunCommand = typeof raw.chatRunCommand === 'string' ? raw.chatRunCommand : '';
  const embeddingRunCommand = typeof raw.embeddingRunCommand === 'string' ? raw.embeddingRunCommand : '';
  if (typeof raw.chatRunCommand !== 'string' || typeof raw.embeddingRunCommand !== 'string') {
    migrated = true;
  }
  // Placeholder default before managed llama-server always included ``--jinja``.
  const legacyDefaultChat = 'llama-server --host 127.0.0.1 --port {{PORT}} -hf org/model:Q4_0';
  if (chatRunCommand.trim() === legacyDefaultChat) {
    chatRunCommand = DEFAULT_MANAGED_LLAMA_CHAT_RUN_COMMAND;
    migrated = true;
  }
  const next: LlamaCppManaged = { chatRunCommand, embeddingRunCommand };
  const tuned = raw.autoTuned as LlamaCppManaged['autoTuned'];
  if (tuned && typeof tuned.c === 'number' && typeof tuned.ctk === 'string' && typeof tuned.ctv === 'string') {
    next.autoTuned = { c: tuned.c, ctk: tuned.ctk, ctv: tuned.ctv };
  }
  model.llamaCppManaged = next;
  return migrated;
}

function collectLegacyHfTokens(providers: LlmProviderConfig[]): SecretValue<string>[] {
  const out: SecretValue<string>[] = [];
  for (const p of providers) {
    for (const m of p.models) {
      const raw = m.llamaCppManaged as unknown as Record<string, unknown> | undefined;
      if (!raw || raw['huggingFaceToken'] == null) {
        continue;
      }
      // Preserve token material into SecretValue (including non-string legacy shapes).
      const wrapped = decryptAndWrapSecret(raw['huggingFaceToken']);
      if (unwrapSecret(wrapped).trim()) {
        out.push(wrapped);
      }
    }
  }
  return out;
}

function stripLegacyHfTokens(providers: LlmProviderConfig[]): boolean {
  let migrated = false;
  for (const p of providers) {
    for (const m of p.models) {
      const raw = m.llamaCppManaged as unknown as Record<string, unknown> | undefined;
      if (raw && 'huggingFaceToken' in raw) {
        // Strip plaintext from legacy tree after collectLegacyHfTokens preserved it.
        delete raw['huggingFaceToken'];
        migrated = true;
      }
    }
  }
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
        p.provider === 'lmstudio'
          ? 'LM Studio'
          : p.provider === 'llamacpp'
            ? 'llama.cpp'
            : p.provider === 'openrouter'
              ? 'OpenRouter'
              : p.provider === 'anthropic'
                ? 'Claude'
                : 'OpenAI';
      migrated = true;
    }
    if (
      p.provider !== 'openai' &&
      p.provider !== 'lmstudio' &&
      p.provider !== 'llamacpp' &&
      p.provider !== 'openrouter' &&
      p.provider !== 'anthropic'
    ) {
      p.provider = 'openai';
      migrated = true;
    }
    if (p.baseUrl === undefined) {
      p.baseUrl =
        p.provider === 'lmstudio'
          ? 'http://127.0.0.1:1234/v1'
          : p.provider === 'llamacpp'
            ? 'http://127.0.0.1:8080/v1'
            : p.provider === 'openrouter'
              ? OPENROUTER_DEFAULT_BASE_URL
              : '';
      migrated = true;
    }
    if (p.provider === 'anthropic') {
      // Never carried in config (see anthropic-key-store); drop anything a client sent.
      if (p.apiKey === undefined || unwrapSecret(p.apiKey) !== '') {
        migrated = true;
      }
      p.apiKey = SecretValue.of('');
    } else if (p.apiKey === undefined) {
      p.apiKey = SecretValue.of(p.provider === 'lmstudio' ? 'lm-studio' : '');
      migrated = true;
    } else {
      const coerced = decryptAndWrapSecret(p.apiKey);
      if (!isSecretValue(p.apiKey) || unwrapSecret(p.apiKey) !== coerced.unwrap()) {
        p.apiKey = coerced;
        migrated = true;
      }
    }
    if (!Array.isArray(p.models) || p.models.length === 0) {
      const mid = defaultLlmModelId(p.provider);
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
          parallelToolCalls: true,
          optimizationPreset: 'generic',
          maxOutputTokens: 0,
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

/** One model profile per source; keeps the active preset when collapsing. */
function collapseExtraModelsPerProvider(providers: LlmProviderConfig[], activeModelId: string): boolean {
  let migrated = false;
  for (const p of providers) {
    if (p.models.length <= 1) {
      continue;
    }
    const picked = p.models.find((m) => m.id === activeModelId) ?? p.models[0];
    if (!picked) {
      continue;
    }
    p.models = [picked];
    migrated = true;
  }
  return migrated;
}

/** Ensure one pinned LM Studio provider exists (stable id, ``lmstudio`` only). */
function ensurePinnedLmStudioProvider(providers: LlmProviderConfig[]): boolean {
  let migrated = false;
  const pinnedIdx = providers.findIndex((p) => p.id === PINNED_LM_STUDIO_PROVIDER_ID);
  if (pinnedIdx >= 0) {
    const pinned = providers[pinnedIdx]!;
    if (pinned.provider !== 'lmstudio') {
      pinned.provider = 'lmstudio';
      migrated = true;
    }
    return migrated;
  }
  const firstLmIdx = providers.findIndex((p) => p.provider === 'lmstudio');
  if (firstLmIdx >= 0) {
    providers[firstLmIdx]!.id = PINNED_LM_STUDIO_PROVIDER_ID;
    return true;
  }
  const insertAt = providers.length > 0 && providers[0]!.provider === 'openai' ? 1 : 0;
  providers.splice(insertAt, 0, createPinnedLmStudioProvider());
  return true;
}

/** Ensure pinned remote ``llama-server`` URL source exists (next to LM Studio in the list). */
function ensurePinnedLlamaServerUrlProvider(providers: LlmProviderConfig[]): boolean {
  if (providers.some((p) => p.id === PINNED_LLAMA_SERVER_URL_PROVIDER_ID)) {
    return false;
  }
  const lmIdx = providers.findIndex((p) => p.id === PINNED_LM_STUDIO_PROVIDER_ID);
  const at = lmIdx >= 0 ? lmIdx + 1 : 1;
  const insert = Math.min(at, providers.length);
  providers.splice(insert, 0, createPinnedLlamaServerUrlProvider());
  return true;
}

/**
 * Ensure the pinned OpenRouter row exists after the local llama source, with its fixed provider
 * and name (Settings offers no rename). Does not change the active model.
 */
function ensurePinnedOpenRouterProvider(providers: LlmProviderConfig[]): boolean {
  const existing = providers.find((p) => p.id === PINNED_OPENROUTER_PROVIDER_ID);
  if (existing) {
    let changed = false;
    if (existing.provider !== 'openrouter') {
      existing.provider = 'openrouter';
      changed = true;
    }
    if (existing.name !== 'OpenRouter') {
      existing.name = 'OpenRouter';
      changed = true;
    }
    return changed;
  }
  const localIdx = providers.findIndex((p) => p.id === PINNED_LLAMA_CPP_LOCAL_PROVIDER_ID);
  const insert = localIdx >= 0 ? localIdx + 1 : providers.length;
  providers.splice(insert, 0, createPinnedOpenRouterProvider());
  return true;
}

/**
 * Ensure the pinned Claude row exists after OpenRouter, with its fixed provider and name.
 * Does not change the active model.
 */
function ensurePinnedAnthropicProvider(providers: LlmProviderConfig[]): boolean {
  const existing = providers.find((p) => p.id === PINNED_ANTHROPIC_PROVIDER_ID);
  if (existing) {
    let changed = false;
    if (existing.provider !== 'anthropic') {
      existing.provider = 'anthropic';
      changed = true;
    }
    if (existing.name !== 'Claude') {
      existing.name = 'Claude';
      changed = true;
    }
    return changed;
  }
  const openRouterIdx = providers.findIndex((p) => p.id === PINNED_OPENROUTER_PROVIDER_ID);
  const insert = openRouterIdx >= 0 ? openRouterIdx + 1 : providers.length;
  providers.splice(insert, 0, createPinnedAnthropicProvider());
  return true;
}

/**
 * Rename managed local ``llama-server`` sources still carrying an old default name
 * (``Llama server (local)``, ``Llama Server N``). Settings has no rename for these
 * (``customName`` is the user's label), so ``name`` is only the no-model fallback.
 */
function renameLegacyManagedLlamaSourceNames(providers: LlmProviderConfig[]): boolean {
  let changed = false;
  for (const p of providers) {
    if (p.provider !== 'llamacpp' || p.id === PINNED_LLAMA_SERVER_URL_PROVIDER_ID) {
      continue;
    }
    if (p.name === 'Llama server (local)' || /^Llama Server \d+$/.test(p.name)) {
      // Numbered past the first so renamed sources stay distinguishable.
      p.name = uniqueManagedLlamaSourceName(providers.filter((o) => o !== p).map((o) => o.name));
      changed = true;
    }
  }
  return changed;
}

/** Ensure pinned managed local ``llama-server`` row exists (after LM Studio + remote URL). */
function ensurePinnedLocalManagedLlamaProvider(providers: LlmProviderConfig[]): boolean {
  if (providers.some((p) => p.id === PINNED_LLAMA_CPP_LOCAL_PROVIDER_ID)) {
    return false;
  }
  const urlIdx = providers.findIndex((p) => p.id === PINNED_LLAMA_SERVER_URL_PROVIDER_ID);
  const at = urlIdx >= 0 ? urlIdx + 1 : providers.length;
  providers.splice(at, 0, createPinnedLocalManagedLlamaProvider());
  return true;
}

/**
 * Ensure the three pinned sources exist in order (LM Studio, remote URL, local managed),
 * preserving user data where possible. Additional non-pinned sources are kept after them.
 */
function migrateLlmProvidersToThreePinnedSources(
  providers: LlmProviderConfig[],
  activeModelId: string,
): { providers: LlmProviderConfig[]; activeModelId: string } {
  const pool = structuredClone(providers) as LlmProviderConfig[];
  const absorbedIds = new Set<string>();

  const lm =
    pool.find((p) => p.id === PINNED_LM_STUDIO_PROVIDER_ID) ??
    pool.find((p) => p.provider === 'lmstudio') ??
    createPinnedLmStudioProvider();
  lm.id = PINNED_LM_STUDIO_PROVIDER_ID;
  lm.provider = 'lmstudio';

  const used = new Set<string>([lm.id]);

  let local: LlmProviderConfig;
  const localPinned = pool.find((p) => p.id === PINNED_LLAMA_CPP_LOCAL_PROVIDER_ID);
  if (localPinned) {
    local = localPinned;
  } else {
    const cand = pool.find(
      (p) =>
        !used.has(p.id) &&
        p.provider === 'llamacpp' &&
        (p.models?.[0]?.llamaCppManaged?.chatRunCommand ?? '').trim(),
    );
    if (cand) {
      absorbedIds.add(cand.id);
      local = structuredClone(cand) as LlmProviderConfig;
    } else {
      local = createPinnedLocalManagedLlamaProvider();
    }
  }
  local.id = PINNED_LLAMA_CPP_LOCAL_PROVIDER_ID;
  if (!local.name?.trim()) {
    local.name = DEFAULT_MANAGED_LLAMA_SOURCE_NAME;
  }
  local.provider = 'llamacpp';
  used.add(local.id);

  let url: LlmProviderConfig;
  const urlPinned = pool.find((p) => p.id === PINNED_LLAMA_SERVER_URL_PROVIDER_ID);
  if (urlPinned) {
    url = urlPinned;
  } else {
    const cand = pool.find(
      (p) =>
        !used.has(p.id) &&
        p.provider === 'llamacpp' &&
        !(p.models?.[0]?.llamaCppManaged?.chatRunCommand ?? '').trim(),
    );
    if (cand) {
      absorbedIds.add(cand.id);
      url = structuredClone(cand) as LlmProviderConfig;
    } else {
      url = createPinnedLlamaServerUrlProvider();
    }
  }
  url.id = PINNED_LLAMA_SERVER_URL_PROVIDER_ID;
  if (!url.name?.trim()) {
    url.name = 'Llama server (URL)';
  }
  url.provider = 'llamacpp';
  if (!(url.embeddingsBaseUrl ?? '').trim()) {
    url.embeddingsBaseUrl =
      process.env.LLAMA_SERVER_EMBEDDINGS_BASE_URL || 'http://127.0.0.1:8081/v1';
  }

  const pinnedTriple = [lm, url, local];
  const pinnedIdSet = new Set([
    PINNED_LM_STUDIO_PROVIDER_ID,
    PINNED_LLAMA_SERVER_URL_PROVIDER_ID,
    PINNED_LLAMA_CPP_LOCAL_PROVIDER_ID,
  ]);
  const extras = pool.filter((p) => !pinnedIdSet.has(p.id) && !absorbedIds.has(p.id));
  const out = [...pinnedTriple, ...extras];
  let nextActive = activeModelId;
  if (!findLlmModelLocation(out, nextActive)) {
    const fallback = lm.models[0]?.id ?? out[0]!.models[0]!.id;
    nextActive = findLlmModelLocation(out, fallback)?.model.id ?? fallback;
  }
  return { providers: out, activeModelId: nextActive };
}

/**
 * Normalize older `config.json` shapes to the current schema; mutates a copy when needed.
 */
export function migrateConfig(config: AppConfig): AppConfig {
  let migrated = false;
  const newConfig: AppConfig = { ...config } as AppConfig;

  // Do not normalize a schema introduced by a newer release: it may no longer use
  // the v1 revision, phases or cursor shapes, and must survive ordinary config saves.
  if (isTutorialProgressSupported(newConfig.tutorial)) {
    const tutorial = normalizeTutorialProgress(newConfig.tutorial);
    if (JSON.stringify(newConfig.tutorial) !== JSON.stringify(tutorial)) {
      newConfig.tutorial = tutorial;
      migrated = true;
    }
  }

  if (!Array.isArray(newConfig.workspaces)) {
    newConfig.workspaces = [];
    migrated = true;
  }

  // Themes are app-wide now (`themeId` only). Strip stale per-workspace / no-workspace theme
  // fields left over from older config files instead of re-filling them.
  for (const workspace of newConfig.workspaces) {
    if ('themeId' in workspace) {
      delete (workspace as { themeId?: string }).themeId;
      migrated = true;
    }
  }

  if ('noWorkspaceThemeId' in newConfig) {
    delete (newConfig as { noWorkspaceThemeId?: string }).noWorkspaceThemeId;
    migrated = true;
  }

  if (!newConfig.themeId || typeof newConfig.themeId !== 'string') {
    newConfig.themeId = FIRST_THEME_ID;
    migrated = true;
  }

  // Pre-engine ids (woodland / classical / dark-classical) map onto the new built-ins. Other
  // ids are user themes on disk; keep them (the renderer falls back to the built-in for the
  // last painted mode when the file is missing) as long as they are well-formed.
  const legacyTheme = LEGACY_THEME_ID_MAP[newConfig.themeId];
  if (legacyTheme) {
    newConfig.themeId = legacyTheme;
    migrated = true;
  } else if (!THEME_ID_PATTERN.test(newConfig.themeId)) {
    newConfig.themeId = FIRST_THEME_ID;
    migrated = true;
  }

  if ('currentWorkspace' in newConfig && typeof (newConfig as { currentWorkspace?: string }).currentWorkspace === 'string') {
    const oldPath = (newConfig as { currentWorkspace: string }).currentWorkspace;
    if (oldPath && newConfig.workspaces.length === 0) {
      const defaultWorkspace = workspaceFromLegacyPath(oldPath);
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

  const rawSchema = (newConfig as { configSchemaVersion?: unknown }).configSchemaVersion;
  const schemaVersion = typeof rawSchema === 'number' && Number.isFinite(rawSchema) ? rawSchema : 0;
  if (schemaVersion < APP_CONFIG_SCHEMA_VERSION) {
    if (schemaVersion < 2) {
      newConfig.llmProviders = getDefaultLlmProviders();
      newConfig.activeLlmModelId =
        newConfig.llmProviders[0]?.models[0]?.id ?? 'default-lmstudio';
    } else if (schemaVersion < 3) {
      const m = migrateLlmProvidersToThreePinnedSources(
        newConfig.llmProviders,
        newConfig.activeLlmModelId,
      );
      newConfig.llmProviders = m.providers;
      newConfig.activeLlmModelId = m.activeModelId;
    } else if (schemaVersion < 4) {
      (newConfig as AppConfig).modelManager = getDefaultModelManagerConfig();
    }
    if (schemaVersion < 5) {
      // Layout default changed to a 1:2:1 workspace:chat:sidebar ratio. Reset the persisted
      // sidebar width so the new default takes effect (the workspace pane width is client-only
      // and already re-initializes to 25% of the viewport on every launch).
      (newConfig as AppConfig).chatSidebarWidthPercent = 1 / 3;
    }
    if (schemaVersion < 6) {
      // Parallel tool calls were parked off in normalize; turn them on for existing profiles.
      for (const provider of newConfig.llmProviders) {
        for (const model of provider.models) {
          model.parallelToolCalls = true;
        }
      }
    }
    if (schemaVersion < 7) {
      // Monaco top padding default moved 0 -> 20px so the first line clears the floating
      // markdown Edit | Preview pill. One-time: a user who sets 0 afterwards keeps it.
      const monaco = (newConfig as AppConfig).monacoWorkspaceEditor;
      if (monaco && monaco.paddingTop === 0) {
        monaco.paddingTop = 20;
      }
    }
    if (schemaVersion < 8) {
      // Theme engine: the Monaco palette now follows the app theme by default. Users who never
      // changed the editor theme (still on the old `vs-dark` default) move to `follow-app`;
      // explicit picks of vs / hc-* are kept.
      const monaco = (newConfig as AppConfig).monacoWorkspaceEditor;
      if (monaco && (monaco.theme as string) === 'vs-dark') {
        monaco.theme = 'follow-app';
      }
    }
    if (schemaVersion < 9) {
      // Compaction was rewritten: the old flag controlled a different, harmful behaviour, so saved
      // configs turn on. A deliberate off cannot be told from the old default and flips once; the
      // release note says so. The old default ratios move; custom ones stay.
      const cc = (newConfig as AppConfig).contextCompression;
      if (cc && typeof cc === 'object') {
        // The old compaction's own settings: nothing reads them any more.
        for (const key of ['protectTailMessages', 'recentToolBodyMaxChars', 'oldToolBodyMaxChars', 'systemReserveRatio']) {
          delete (cc as unknown as Record<string, unknown>)[key];
        }
        cc.enabled = true;
        if (cc.triggerRatio === 0.7) {
          cc.triggerRatio = 0.8;
        }
        if (cc.targetRatio === 0.55) {
          cc.targetRatio = 0.5;
        }
      }
      // Only the flag the app's own builder wrote, in its order: `--cache-ram -1` or a value the
      // user placed elsewhere stays, and later saves are not touched (this runs once).
      for (const provider of newConfig.llmProviders) {
        for (const model of provider.models) {
          const managed = model.llamaCppManaged;
          if (managed && typeof managed.chatRunCommand === 'string') {
            managed.chatRunCommand = managed.chatRunCommand.replace(
              /(-np\s+1\s+--no-webui)\s+--cache-ram\s+0(?=\s|$)/g,
              '$1',
            );
          }
        }
      }
    }
    (newConfig as { configSchemaVersion: number }).configSchemaVersion = APP_CONFIG_SCHEMA_VERSION;
    migrated = true;
  }

  const legacyHfTokens = collectLegacyHfTokens(newConfig.llmProviders);

  if (normalizeLlmProvidersTree(newConfig.llmProviders)) {
    migrated = true;
  }

  if (ensurePinnedLmStudioProvider(newConfig.llmProviders)) {
    migrated = true;
  }

  if (ensurePinnedLlamaServerUrlProvider(newConfig.llmProviders)) {
    migrated = true;
  }

  if (ensurePinnedLocalManagedLlamaProvider(newConfig.llmProviders)) {
    migrated = true;
  }

  if (ensurePinnedOpenRouterProvider(newConfig.llmProviders)) {
    migrated = true;
  }

  if (ensurePinnedAnthropicProvider(newConfig.llmProviders)) {
    migrated = true;
  }

  if (renameLegacyManagedLlamaSourceNames(newConfig.llmProviders)) {
    migrated = true;
  }

  const wantOrder = [
    PINNED_LM_STUDIO_PROVIDER_ID,
    PINNED_LLAMA_SERVER_URL_PROVIDER_ID,
    PINNED_LLAMA_CPP_LOCAL_PROVIDER_ID,
  ];
  const hasAllPins = wantOrder.every((id) => newConfig.llmProviders.some((p) => p.id === id));
  const firstThreeOrdered = wantOrder.every((id, i) => newConfig.llmProviders[i]?.id === id);
  const needsThreeSourceReshape =
    newConfig.llmProviders.length < 3 || !hasAllPins || !firstThreeOrdered;
  if (needsThreeSourceReshape) {
    const m = migrateLlmProvidersToThreePinnedSources(
      newConfig.llmProviders,
      newConfig.activeLlmModelId,
    );
    newConfig.llmProviders = m.providers;
    newConfig.activeLlmModelId = m.activeModelId;
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
        : (newConfig.llmProviders[0]?.models[0]?.id ?? 'default-lmstudio');
    migrated = true;
  }

  delete (newConfig as { llmConnections?: unknown }).llmConnections;
  delete (newConfig as { activeLlmConnectionId?: unknown }).activeLlmConnectionId;

  if (!findLlmModelLocation(newConfig.llmProviders, newConfig.activeLlmModelId)) {
    newConfig.activeLlmModelId = newConfig.llmProviders[0]?.models[0]?.id ?? 'default-lmstudio';
    migrated = true;
  }

  if (collapseExtraModelsPerProvider(newConfig.llmProviders, newConfig.activeLlmModelId)) {
    migrated = true;
  }

  if (!newConfig.audioTranscription) {
    newConfig.audioTranscription = getDefaultAudioTranscription();
    migrated = true;
  } else {
    const audio = newConfig.audioTranscription;
    // Retired persisted value from Google web STT; not a live AudioTranscriptionProvider.
    const rawProvider = audio.provider as string | undefined;
    if (rawProvider === 'google') {
      audio.provider = 'whisper';
      audio.baseUrl = '';
      audio.apiKey = SecretValue.of('');
      if (!audio.model || audio.model === 'google-web-speech') {
        audio.model = DEFAULT_WHISPER_MODEL;
      }
      migrated = true;
    } else if (!audio.provider) {
      audio.provider = 'openai';
      migrated = true;
    } else if (
      audio.provider !== 'openai' &&
      audio.provider !== 'disabled' &&
      audio.provider !== 'whisper'
    ) {
      audio.provider = 'openai';
      migrated = true;
    }
    if (audio.baseUrl === undefined) {
      audio.baseUrl = '';
      migrated = true;
    }
    if (audio.model === 'google-web-speech') {
      audio.model = DEFAULT_WHISPER_MODEL;
      migrated = true;
    }
    if (!audio.model) {
      audio.model =
        audio.provider === 'whisper' ? DEFAULT_WHISPER_MODEL : DEFAULT_OPENAI_TRANSCRIBE_MODEL;
      migrated = true;
    }
    if (audio.apiKey === undefined) {
      audio.apiKey = SecretValue.of('');
      migrated = true;
    } else {
      const coerced = decryptAndWrapSecret(audio.apiKey);
      if (!isSecretValue(audio.apiKey) || unwrapSecret(audio.apiKey) !== coerced.unwrap()) {
        audio.apiKey = coerced;
        migrated = true;
      }
    }
    if (audio.talkInputDeviceId === undefined || typeof audio.talkInputDeviceId !== 'string') {
      audio.talkInputDeviceId = 'default';
      migrated = true;
    }
    const thr = audio.talkSilenceThresholdSeconds;
    if (typeof thr !== 'number' || Number.isNaN(thr) || thr < 0.5 || thr > 5) {
      audio.talkSilenceThresholdSeconds = 2;
      migrated = true;
    }
    const atRecord = audio as AudioTranscriptionConfig & { ttsVoiceId?: string };
    if (atRecord.ttsProvider !== 'kokoro' && atRecord.ttsProvider !== 'openai-compatible') {
      atRecord.ttsProvider = DEFAULT_TTS_PROVIDER;
      migrated = true;
    }
    if (typeof atRecord.ttsBaseUrl !== 'string') {
      atRecord.ttsBaseUrl = DEFAULT_OPENAI_TTS_BASE_URL;
      migrated = true;
    }
    if (atRecord.ttsApiKey === undefined) {
      atRecord.ttsApiKey = SecretValue.of('');
      migrated = true;
    } else {
      // Clamp/coerce without dropping secret material (legacy plaintext or SecretValue).
      const coerced = decryptAndWrapSecret(atRecord.ttsApiKey);
      if (!isSecretValue(atRecord.ttsApiKey) || unwrapSecret(atRecord.ttsApiKey) !== coerced.unwrap()) {
        atRecord.ttsApiKey = coerced;
        migrated = true;
      }
    }
    if (typeof atRecord.ttsDefaultInstructions !== 'string') {
      atRecord.ttsDefaultInstructions = '';
      migrated = true;
    }
    if (atRecord.ttsVoice === undefined && typeof atRecord.ttsVoiceId === 'string') {
      const legacy = atRecord.ttsVoiceId.trim();
      const isEdgeOrEmpty =
        !legacy || /neural/i.test(legacy) || /^en-/i.test(legacy) || /^[a-z]{2}-[A-Z]{2}-/.test(legacy);
      atRecord.ttsVoice = isEdgeOrEmpty ? DEFAULT_KOKORO_TTS_VOICE : legacy;
      delete atRecord.ttsVoiceId;
      migrated = true;
    }
    const ttsProvider = atRecord.ttsProvider ?? DEFAULT_TTS_PROVIDER;
    const defaultTtsVoice =
      ttsProvider === 'openai-compatible' ? DEFAULT_OPENAI_TTS_VOICE : DEFAULT_KOKORO_TTS_VOICE;
    const tv = atRecord.ttsVoice;
    if (typeof tv !== 'string' || !tv.trim()) {
      atRecord.ttsVoice = defaultTtsVoice;
      migrated = true;
    }
    const tsp = atRecord.ttsSpeechSpeed;
    if (typeof tsp !== 'number' || Number.isNaN(tsp) || tsp < TTS_SPEECH_SPEED_MIN || tsp > TTS_SPEECH_SPEED_MAX) {
      atRecord.ttsSpeechSpeed = TTS_SPEECH_SPEED_DEFAULT;
      migrated = true;
    }
    if ('ttsVoiceId' in atRecord) {
      delete atRecord.ttsVoiceId;
      migrated = true;
    }
  }

  const cfs = (newConfig as AppConfig).chatFontSizeRem;
  if (typeof cfs !== 'number' || Number.isNaN(cfs) || cfs < 0.6 || cfs > 1.6) {
    (newConfig as AppConfig).chatFontSizeRem = 0.9;
    migrated = true;
  }

  const ufs = (newConfig as AppConfig).uiFontSizeRem;
  if (typeof ufs !== 'number' || Number.isNaN(ufs) || ufs < 0.8 || ufs > 1.4) {
    (newConfig as AppConfig).uiFontSizeRem = 1.1;
    migrated = true;
  }

  const csw = (newConfig as AppConfig).chatSidebarWidthPercent;
  if (typeof csw !== 'number' || Number.isNaN(csw) || csw < 0.05 || csw > 0.95) {
    (newConfig as AppConfig).chatSidebarWidthPercent = 1 / 3;
    migrated = true;
  }

  const defaultHome = (newConfig as AppConfig).defaultHomePageOnStart;
  if (typeof defaultHome !== 'boolean') {
    (newConfig as AppConfig).defaultHomePageOnStart = false;
    migrated = true;
  }

  const collapsed = (newConfig as AppConfig).chatSidebarCollapsed;
  if (typeof collapsed !== 'boolean') {
    (newConfig as AppConfig).chatSidebarCollapsed = false;
    migrated = true;
  }

  const expanded = (newConfig as AppConfig).chatExpandedToMainPanel;
  if (typeof expanded !== 'boolean') {
    (newConfig as AppConfig).chatExpandedToMainPanel = false;
    migrated = true;
  } else if ((newConfig as AppConfig).chatSidebarCollapsed && expanded) {
    (newConfig as AppConfig).chatExpandedToMainPanel = false;
    migrated = true;
  }

  const normalizedContainerSize = normalizeChatContainerSize((newConfig as AppConfig).chatContainerSize);
  if ((newConfig as AppConfig).chatContainerSize !== normalizedContainerSize) {
    (newConfig as AppConfig).chatContainerSize = normalizedContainerSize;
    migrated = true;
  }

  const normalizedThinkingDisplay = normalizeChatThinkingDisplay((newConfig as AppConfig).chatThinkingDisplay);
  if ((newConfig as AppConfig).chatThinkingDisplay !== normalizedThinkingDisplay) {
    (newConfig as AppConfig).chatThinkingDisplay = normalizedThinkingDisplay;
    migrated = true;
  }

  const uiFont = (newConfig as AppConfig).uiFontFamily;
  if (uiFont !== undefined && typeof uiFont !== 'string') {
    (newConfig as AppConfig).uiFontFamily = '';
    migrated = true;
  }

  const codeFont = (newConfig as AppConfig).codeFontFamily;
  if (codeFont !== undefined && typeof codeFont !== 'string') {
    (newConfig as AppConfig).codeFontFamily = '';
    migrated = true;
  }

  const monacoPrev = (newConfig as AppConfig).monacoWorkspaceEditor;
  const { settings: monacoNorm, migrated: monacoMigrated } = normalizeMonacoWorkspaceEditorSettings(monacoPrev);
  if (monacoMigrated || monacoPrev === undefined) {
    (newConfig as AppConfig).monacoWorkspaceEditor = monacoNorm;
    migrated = true;
  }
  // 300ms was the previous shipped default and felt too eager; bump leftover values.
  const monacoEditor = (newConfig as AppConfig).monacoWorkspaceEditor;
  if (monacoEditor?.hoverDelay === 300) {
    monacoEditor.hoverDelay = 500;
    migrated = true;
  }
  const wtRaw = (newConfig as AppConfig & { workspaceTools?: WorkspaceToolsConfig }).workspaceTools;
  if (!wtRaw) {
    (newConfig as AppConfig).workspaceTools = getDefaultWorkspaceTools();
    migrated = true;
  } else {
    const wt = wtRaw;
    const retention = normalizeScreenshotRetention(wt.screenshotRetention);
    if (JSON.stringify(wt.screenshotRetention) !== JSON.stringify(retention)) {
      wt.screenshotRetention = retention;
      migrated = true;
    }
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
    if ('orchestratedMode' in wt) {
      delete (wt as { orchestratedMode?: boolean }).orchestratedMode;
      migrated = true;
    }
    if ('outerPhasedCodingCycle' in wt) {
      delete (wt as { outerPhasedCodingCycle?: boolean }).outerPhasedCodingCycle;
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
    const explainStepRaw = (wt as unknown as { commandLineExplainStep?: unknown }).commandLineExplainStep;
    if (typeof explainStepRaw === 'string') {
      const s = explainStepRaw.trim().toLowerCase();
      wt.commandLineExplainStep = s === 'true' || s === '1' || s === 'yes' || s === 'on';
      migrated = true;
    } else if (typeof explainStepRaw !== 'boolean') {
      wt.commandLineExplainStep = false;
      migrated = true;
    }
    const exposeAllRaw = (wt as unknown as { exposeAllWorkspaceFiles?: unknown }).exposeAllWorkspaceFiles;
    if (typeof exposeAllRaw === 'string') {
      const s = exposeAllRaw.trim().toLowerCase();
      wt.exposeAllWorkspaceFiles = s === 'true' || s === '1' || s === 'yes' || s === 'on';
      migrated = true;
    } else if (typeof exposeAllRaw !== 'boolean') {
      wt.exposeAllWorkspaceFiles = false;
      migrated = true;
    }
    const allowWebRaw = (wt as unknown as { allowWebAccess?: unknown }).allowWebAccess;
    if (typeof allowWebRaw === 'string') {
      const s = allowWebRaw.trim().toLowerCase();
      wt.allowWebAccess = s === 'true' || s === '1' || s === 'yes' || s === 'on';
      migrated = true;
    } else if (typeof allowWebRaw !== 'boolean') {
      wt.allowWebAccess = false;
      migrated = true;
    }
    const searxngRaw = (wt as unknown as { searxngBaseUrl?: unknown }).searxngBaseUrl;
    if (typeof searxngRaw !== 'string') {
      wt.searxngBaseUrl = '';
      migrated = true;
    } else {
      const trimmed = searxngRaw.trim();
      if (trimmed !== searxngRaw) {
        wt.searxngBaseUrl = trimmed;
        migrated = true;
      }
    }
    const providerRaw = (wt as unknown as { webSearchProvider?: unknown }).webSearchProvider;
    if (providerRaw !== 'auto' && providerRaw !== 'internal' && providerRaw !== 'searxng') {
      wt.webSearchProvider = 'auto';
      migrated = true;
    }
    const enginesRaw = (wt as unknown as { webSearchEngines?: unknown }).webSearchEngines;
    const engines = normalizeWebSearchEngines(enginesRaw);
    if (JSON.stringify(engines) !== JSON.stringify(enginesRaw)) {
      wt.webSearchEngines = engines;
      migrated = true;
    }
    const uaRaw = (wt as unknown as { webSearchUserAgent?: unknown }).webSearchUserAgent;
    if (typeof uaRaw !== 'string') {
      wt.webSearchUserAgent = '';
      migrated = true;
    } else {
      const trimmed = uaRaw.trim();
      if (trimmed !== uaRaw) {
        wt.webSearchUserAgent = trimmed;
        migrated = true;
      }
    }
    const cooldownRaw = (wt as unknown as { webSearchCooldownSeconds?: unknown }).webSearchCooldownSeconds;
    if (typeof cooldownRaw !== 'number' || !Number.isFinite(cooldownRaw)) {
      wt.webSearchCooldownSeconds = 300;
      migrated = true;
    } else {
      const clamped = Math.min(3600, Math.max(0, Math.round(cooldownRaw)));
      if (clamped !== cooldownRaw) {
        wt.webSearchCooldownSeconds = clamped;
        migrated = true;
      }
    }
    const extraPathRaw = (wt as unknown as { extraUserPath?: unknown }).extraUserPath;
    if (typeof extraPathRaw !== 'string') {
      wt.extraUserPath = '';
      migrated = true;
    } else if (extraPathRaw.length > 16_384) {
      wt.extraUserPath = extraPathRaw.slice(0, 16_384);
      migrated = true;
    }
    const formattersRaw = (wt as unknown as { enableAgentFormatters?: unknown }).enableAgentFormatters;
    if (typeof formattersRaw === 'string') {
      const s = formattersRaw.trim().toLowerCase();
      wt.enableAgentFormatters = s === 'true' || s === '1' || s === 'yes' || s === 'on';
      migrated = true;
    } else if (typeof formattersRaw !== 'boolean') {
      wt.enableAgentFormatters = false;
      migrated = true;
    }
  }

  const ccRaw = (newConfig as AppConfig & { contextCompression?: ContextCompressionConfig }).contextCompression;
  if (!ccRaw || typeof ccRaw !== 'object') {
    (newConfig as AppConfig).contextCompression = getDefaultContextCompression();
    migrated = true;
  } else {
    const cc = ccRaw;
    if (typeof cc.enabled !== 'boolean') {
      cc.enabled = true;
      migrated = true;
    }
    if (typeof cc.triggerRatio !== 'number' || cc.triggerRatio < 0.5 || cc.triggerRatio > 0.95) {
      cc.triggerRatio = 0.8;
      migrated = true;
    }
    if (typeof cc.targetRatio !== 'number' || cc.targetRatio < 0.4 || cc.targetRatio > 0.9) {
      cc.targetRatio = 0.5;
      migrated = true;
    }
    const maxTarget = maxContextCompressionTarget(cc.triggerRatio);
    if (cc.targetRatio > maxTarget) {
      cc.targetRatio = Math.min(maxTarget, 0.5);
      migrated = true;
    }
  }

  const lab = (newConfig as AppConfig & { lastActiveConversationByWorkspaceId?: unknown })
    .lastActiveConversationByWorkspaceId;
  if (!lab || typeof lab !== 'object' || Array.isArray(lab)) {
    (newConfig as AppConfig).lastActiveConversationByWorkspaceId = {};
    migrated = true;
  }

  const scrollNorm = normalizeWorkspaceMonacoScrollByWorkspaceId(
    (newConfig as AppConfig).workspaceMonacoScrollByWorkspaceId,
  );
  if (scrollNorm.migrated) {
    (newConfig as AppConfig).workspaceMonacoScrollByWorkspaceId = scrollNorm.scrollByWorkspaceId;
    migrated = true;
  }

  const openTabsNorm = normalizeWorkspaceOpenTabsByWorkspaceId(
    (newConfig as AppConfig).workspaceOpenTabsByWorkspaceId,
  );
  if (openTabsNorm.migrated) {
    (newConfig as AppConfig).workspaceOpenTabsByWorkspaceId = openTabsNorm.openTabsByWorkspaceId;
    migrated = true;
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

  const mmRaw = (newConfig as AppConfig & { modelManager?: unknown }).modelManager;
  if (!mmRaw || typeof mmRaw !== 'object' || Array.isArray(mmRaw)) {
    (newConfig as AppConfig).modelManager = getDefaultModelManagerConfig();
    migrated = true;
  } else {
    const mm = mmRaw as {
      customModelsDir?: unknown;
      huggingFaceToken?: unknown;
      detectedCaches?: unknown;
    };
    const customModelsDir = typeof mm.customModelsDir === 'string' ? mm.customModelsDir.trim() : '';
    const huggingFaceToken = decryptAndWrapSecret(mm.huggingFaceToken);
    const fallback = getDefaultModelManagerConfig();
    // Empty only — do not rewrite a saved ``~/models`` path (may already hold downloads).
    const nextCustomDir = customModelsDir || fallback.customModelsDir;
    if (nextCustomDir !== mm.customModelsDir) {
      mm.customModelsDir = nextCustomDir;
      migrated = true;
    }
    // Wrap into SecretValue; never persist/keep raw plaintext shape after coerce.
    if (
      !isSecretValue(mm.huggingFaceToken) ||
      unwrapSecret(mm.huggingFaceToken) !== huggingFaceToken.unwrap()
    ) {
      mm.huggingFaceToken = huggingFaceToken;
      migrated = true;
    }
    if ('detectedCaches' in mm) {
      delete mm.detectedCaches;
      migrated = true;
    }
  }

  const mm = (newConfig as AppConfig).modelManager;
  if (!unwrapSecret(mm.huggingFaceToken) && legacyHfTokens.length > 0) {
    mm.huggingFaceToken = legacyHfTokens[0]!;
    migrated = true;
  }
  if (stripLegacyHfTokens(newConfig.llmProviders)) {
    migrated = true;
  }

  const mcpNorm = normalizeMcpServers((newConfig as AppConfig).mcpServers);
  (newConfig as AppConfig).mcpServers = mcpNorm.servers;
  if (mcpNorm.migrated) {
    migrated = true;
  }

  return migrated ? newConfig : config;
}

const CONFIG_BACKUP_SUFFIX = '.bak';
const CONFIG_TEMP_SUFFIX = '.tmp';
const CONFIG_READ_RETRIES = 3;
const CONFIG_READ_RETRY_MS = 25;

let configMutationChain: Promise<unknown> = Promise.resolve();
const CONFIG_LOCK_STALE_MS = 4_000;
const CONFIG_LOCK_TIMEOUT_MS = 20_000;

function configLockOwnerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // Fail closed on permission/other errors; only ESRCH proves that the owner is gone.
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

type ConfigLockOwner = { pid: number; token: string };

async function readConfigLockOwner(lockPath: string): Promise<ConfigLockOwner | null> {
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const owner = asRecord(JSON.parse(raw));
    if (owner && typeof owner['pid'] === 'number' && Number.isSafeInteger(owner['pid']) && owner['pid'] > 0 &&
        typeof owner['token'] === 'string' && owner['token'].length > 0 && owner['token'].length <= 512) {
      return { pid: owner['pid'], token: owner['token'] };
    }
  } catch { /* An incomplete lock is not safe to steal. */ }
  return null;
}

/** Reclaim only a proven-dead owner, with one recovery guard per immutable owner token. */
async function recoverAbandonedConfigLock(
  lockPath: string,
  publishLock: (destination: string) => Promise<void>,
  depth = 0,
): Promise<void> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (Date.now() - stat.mtimeMs <= CONFIG_LOCK_STALE_MS) return;
  const owner = await readConfigLockOwner(lockPath);
  if (!owner || configLockOwnerAlive(owner.pid)) return;
  const key = createHash('sha256').update(JSON.stringify([owner.pid, owner.token])).digest('hex').slice(0, 32);
  const recoveryPath = `${lockPath}.recovery.${key}`;
  try {
    await publishLock(recoveryPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // A recovery process can itself crash. Recover its owned guard using the same
    // protocol; bound nesting so a damaged filesystem cannot create unbounded paths.
    if (depth < 3) await recoverAbandonedConfigLock(recoveryPath, publishLock, depth + 1);
    return;
  }
  try {
    const current = await readConfigLockOwner(lockPath);
    // Another reclaimer may have removed the old lock and a live process may have
    // installed a new one. Never unlink unless the exact dead owner is still present.
    if (current?.pid === owner.pid && current.token === owner.token && !configLockOwnerAlive(owner.pid)) {
      await fs.rm(lockPath, { force: true });
    }
  } finally {
    await fs.rm(recoveryPath, { force: true });
  }
}

/** Remove only our private staging files left by an interrupted writer, while holding the lock. */
async function cleanupOrphanedConfigTemps(configPath: string): Promise<void> {
  const directory = path.dirname(configPath);
  const prefix = `${path.basename(configPath)}.`;
  const stagingName = /^(?:bak\.)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;
  try {
    for (const name of await fs.readdir(directory)) {
      if (name.startsWith(prefix) && stagingName.test(name.slice(prefix.length))) {
        // unlink removes a symlink itself, never the file it points at.
        await fs.unlink(path.join(directory, name)).catch(() => {});
      }
    }
  } catch {
    // Cleanup is best-effort; failure must not prevent loading the existing config.
  }
}

/** Serialize config mutations across app processes as well as windows. */
async function withConfigFileLock<T>(operation: () => Promise<T>): Promise<T> {
  const lockPath = `${getConfigPath()}.lock`;
  const configDir = path.dirname(lockPath);
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  try { await fs.chmod(configDir, 0o700); } catch { /* Best-effort on Windows. */ }
  const token = `${process.pid}-${randomUUID()}`;
  const payload = JSON.stringify({ pid: process.pid, token });
  const candidate = `${lockPath}.${token}.candidate`;
  // Publishing a complete file via a hard link eliminates the empty-lock crash window.
  await fs.writeFile(candidate, payload, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
  const deadline = Date.now() + CONFIG_LOCK_TIMEOUT_MS;
  let hardLinksSupported = true;
  const publishLock = async (destination: string): Promise<void> => {
    if (hardLinksSupported) {
      try {
        await fs.link(candidate, destination);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'].includes(code ?? '')) throw err;
        hardLinksSupported = false;
      }
    }
    // Filesystems without hard links fall back to exclusive create. An incomplete
    // fallback lock is not reclaimed automatically, since its owner is unknowable.
    const handle = await fs.open(destination, 'wx', 0o600);
    try {
      await handle.writeFile(payload, 'utf-8');
    } catch (err) {
      await handle.close().catch(() => {});
      await fs.rm(destination, { force: true });
      throw err;
    }
    await handle.close();
  };
  try {
    while (true) {
      try {
        await publishLock(lockPath);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        await recoverAbandonedConfigLock(lockPath, publishLock);
        if (Date.now() >= deadline) throw new Error('Timed out waiting for the configuration lock.');
        await sleep(25);
      }
    }

    try {
      await cleanupOrphanedConfigTemps(getConfigPath());
      return await operation();
    } finally {
      const current = await readConfigLockOwner(lockPath);
      if (current?.pid === process.pid && current.token === token) await fs.rm(lockPath, { force: true });
    }
  } finally {
    await fs.rm(candidate, { force: true });
  }
}

function runSerializedConfigMutation<T>(operation: () => Promise<T>): Promise<T> {
  const run = configMutationChain.then(() => withConfigFileLock(operation), () => withConfigFileLock(operation));
  configMutationChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readConfigRawFromPath(filePath: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < CONFIG_READ_RETRIES; attempt++) {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      if (raw.trim()) {
        return raw;
      }
      lastError = new Error('Config file is empty.');
    } catch (err) {
      lastError = err;
    }
    if (attempt < CONFIG_READ_RETRIES - 1) {
      await sleep(CONFIG_READ_RETRY_MS * (attempt + 1));
    }
  }
  throw lastError;
}

function readConfigRawFromPathSync(filePath: string): string {
  const raw = syncFs.readFileSync(filePath, 'utf-8');
  if (!raw.trim()) {
    throw new Error('Config file is empty.');
  }
  return raw;
}

async function configFileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function readConfigFromDiskForMutation(): Promise<AppConfig> {
  const configPath = getConfigPath();
  const backupPath = `${configPath}${CONFIG_BACKUP_SUFFIX}`;
  let unreadable = false;

  for (const filePath of [configPath, backupPath]) {
    let parsed: AppConfig;
    let raw: string;
    try {
      raw = await readConfigRawFromPath(filePath);
      // Never log `raw` — may contain plaintext or encrypted secrets.
      const document = asRecord(JSON.parse(raw));
      if (!document) throw new Error('Invalid config document');
      parsed = migrateConfig(document as unknown as AppConfig);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') unreadable = true;
      // Do not log err stacks that might echo file snippets; keep message generic.
      continue;
    }
    if (filePath === backupPath) {
      console.warn('[config] restored config from backup file.');
      // Restore the raw backup, not migrated/decrypted data: the keychain may be
      // temporarily unavailable, and the good backup must remain untouched as well.
      await writeConfigDocumentToDiskUnsafe(JSON.parse(raw) as Record<string, unknown>, false);
    }
    return parsed;
  }

  if (unreadable) {
    console.error('[config] config or backup could not be read; refusing to reset.');
    throw new Error('Config file is corrupt and no valid backup is available.');
  }

  const defaultConfig = createDefaultConfig();
  await writeConfigToDiskUnsafe(defaultConfig);
  return defaultConfig;
}

/** Write a private, uniquely named file in the destination directory and flush its contents. */
async function writePrivateConfigTemp(destination: string, data: string | Buffer): Promise<string> {
  const temporary = `${destination}.${randomUUID()}${CONFIG_TEMP_SUFFIX}`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    return temporary;
  } catch (err) {
    await handle.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw err;
  }
}

/** Write an already-serialized document, retaining unknown fields and encrypted secrets verbatim. */
async function writeConfigDocumentToDiskUnsafe(
  diskSafe: Record<string, unknown>,
  backupCurrent = true,
  canCommit: () => boolean = () => true,
): Promise<boolean> {
  const configPath = getConfigPath();
  const backupPath = `${configPath}${CONFIG_BACKUP_SUFFIX}`;
  const configDir = path.dirname(configPath);
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  // mkdir mode only applies on create; tighten pre-existing dirs too.
  try {
    await fs.chmod(configDir, 0o700);
  } catch {
    // Best-effort on platforms that ignore directory modes.
  }

  const temporary = await writePrivateConfigTemp(configPath, JSON.stringify(diskSafe, null, 2));
  let backupTemporary: string | null = null;
  try {
    if (!canCommit()) return false;
    if (backupCurrent && await configFileExists(configPath)) {
      // A unique 0600 staging file and rename avoid following an existing backup symlink
      // or leaving a partially overwritten backup if the process is interrupted.
      backupTemporary = await writePrivateConfigTemp(backupPath, await fs.readFile(configPath));
      await fs.rename(backupTemporary, backupPath);
      backupTemporary = null;
      await chmod600BestEffort(backupPath);
    }
    if (!canCommit()) return false;
    await fs.rename(temporary, configPath);
    await chmod600BestEffort(configPath);
    return true;
  } finally {
    await fs.rm(temporary, { force: true });
    if (backupTemporary) await fs.rm(backupTemporary, { force: true });
  }
}

async function writeConfigToDiskUnsafe(config: AppConfig, backupCurrent = true): Promise<void> {
  // Encrypt secrets before stringify; SecretValue.toJSON would otherwise redact them.
  const diskSafe = serializeConfigForDisk(config);
  const payload = JSON.stringify(diskSafe);
  if (payload.includes('"apiKey":"[REDACTED]"') || payload.includes('"huggingFaceToken":"[REDACTED]"')) {
    console.warn('[config] secret field redacted in disk payload; check serializeConfigForDisk.');
  }
  await writeConfigDocumentToDiskUnsafe(diskSafe, backupCurrent);
}

/** Read raw data for a tutorial-only mutation: never decrypt/re-encrypt unrelated credentials. */
async function readTutorialConfigDocument(): Promise<Record<string, unknown>> {
  const configPath = getConfigPath();
  const backupPath = `${configPath}${CONFIG_BACKUP_SUFFIX}`;
  let unreadable = false;
  for (const filePath of [configPath, backupPath]) {
    let document: Record<string, unknown>;
    try {
      const parsed = asRecord(JSON.parse(await readConfigRawFromPath(filePath)));
      if (!parsed) throw new Error('Invalid config document');
      document = parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') unreadable = true;
      // Never log raw config or exception details, which may contain secrets.
      continue;
    }
    if (filePath === backupPath) {
      console.warn('[config] restored config from backup file.');
      // Do not replace the good backup with the broken primary while recovering.
      await writeConfigDocumentToDiskUnsafe(document, false);
    }
    return document;
  }
  if (unreadable) throw new Error('Config file is corrupt and no valid backup is available.');
  const defaults = serializeConfigForDisk(createDefaultConfig());
  await writeConfigDocumentToDiskUnsafe(defaults);
  return defaults;
}

/**
 * The Claude model is set through ``anthropic:set-model`` (Settings and the composer), so a
 * Settings save drafted before a composer pick must not roll it back.
 */
function keepDiskClaudeModel(disk: LlmProviderConfig[], client: LlmProviderConfig[]): LlmProviderConfig[] {
  const diskModel = disk.find((p) => p.id === PINNED_ANTHROPIC_PROVIDER_ID)?.models[0];
  if (!diskModel) {
    return client;
  }
  return client.map((p) => {
    if (p.id !== PINNED_ANTHROPIC_PROVIDER_ID || !p.models[0]) {
      return p;
    }
    const [first, ...rest] = p.models;
    return {
      ...p,
      models: [
        { ...first, model: diskModel.model, name: diskModel.name, contextWindowTokens: diskModel.contextWindowTokens },
        ...rest,
      ],
    };
  });
}

/** Preserve workspace registry fields owned by dedicated IPC handlers. */
export function mergeSettingsConfigSave(disk: AppConfig, client: AppConfig): AppConfig {
  // Client-wins settings merge; never log client/disk (secrets).
  // Read MCP touch flags first — migrate keeps them, but merge must see the pre-normalize client.
  const flags = mcpMergeFlags(client.mcpServers);
  const screenshotRetention = normalizeScreenshotRetention({
    ...disk.workspaceTools?.screenshotRetention,
    ...client.workspaceTools?.screenshotRetention,
  });
  const clientMigrated = migrateConfig(client);
  return {
    ...clientMigrated,
    llmProviders: keepDiskClaudeModel(disk.llmProviders, clientMigrated.llmProviders),
    workspaceTools: { ...clientMigrated.workspaceTools, screenshotRetention },
    // Tutorial transitions have their own revision-checked IPC; a stale Settings draft
    // must never resurrect dismissed phases or move the committed cursor backwards.
    tutorial: isTutorialProgressSupported(disk.tutorial) ? normalizeTutorialProgress(disk.tutorial) : disk.tutorial,
    workspaces: disk.workspaces,
    currentWorkspaceId: disk.currentWorkspaceId,
    lastActiveConversationByWorkspaceId: disk.lastActiveConversationByWorkspaceId,
    workspaceMonacoScrollByWorkspaceId: disk.workspaceMonacoScrollByWorkspaceId,
    workspaceOpenTabsByWorkspaceId: disk.workspaceOpenTabsByWorkspaceId,
    mcpServers: mergeMcpServers(disk.mcpServers ?? [], clientMigrated.mcpServers ?? [], flags),
  };
}

/** Serialized load → mutate → save. Mutator may mutate in place or return a replacement config. */
export async function updateConfig(
  mutator: (config: AppConfig) => AppConfig | void | Promise<AppConfig | void>,
): Promise<AppConfig> {
  return runSerializedConfigMutation(async () => {
    let config = await readConfigFromDiskForMutation();
    const result = await mutator(config);
    if (result !== undefined) {
      config = result;
    }
    const migrated = migrateConfig(config);
    await writeConfigToDiskUnsafe(migrated);
    // Plain strings for IPC consumers; do not log migrated/config (secrets).
    return exposeSecretsForConsumers(migrated);
  });
}

/** Atomically compare and update just the tutorial cursor inside the config write queue. */
export async function updateTutorialProgress(
  request: TutorialTransition,
  canApply: () => boolean = () => true,
): Promise<{ applied: boolean; progress: TutorialProgress }> {
  return runSerializedConfigMutation(async () => {
    const document = await readTutorialConfigDocument();
    const progress = normalizeTutorialProgress(document['tutorial']);
    if (!canApply()) return { applied: false, progress };
    const result = applyTutorialTransition(progress, request);
    if (result.applied) {
      document['tutorial'] = result.progress;
      // A window may release/crash while the temporary file or backup is being written.
      // Recheck its lease immediately before publishing the new primary document.
      if (!await writeConfigDocumentToDiskUnsafe(document, true, canApply)) return { applied: false, progress };
    }
    return result;
  });
}

/** Read only tutorial data without decrypting or migrating unrelated config fields. */
export async function loadTutorialProgress(): Promise<TutorialProgress> {
  return runSerializedConfigMutation(async () => normalizeTutorialProgress((await readTutorialConfigDocument())['tutorial']));
}

/** Async load; creates default file on first run. */
export async function loadConfig(): Promise<AppConfig> {
  return runSerializedConfigMutation(async () => {
    const config = await readConfigFromDiskForMutation();
    const migrated = migrateConfig(config);
    if (migrated !== config) {
      await writeConfigToDiskUnsafe(migrated);
      return exposeSecretsForConsumers(migrated);
    }
    return exposeSecretsForConsumers(config);
  });
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await runSerializedConfigMutation(async () => {
    const disk = await readConfigFromDiskForMutation();
    await writeConfigToDiskUnsafe(migrateConfig({ ...config, tutorial: disk.tutorial }));
  });
}

/** Sync read for menu “recent” without async file IO in the menu builder path. */
export function loadConfigSync(): AppConfig {
  const configPath = getConfigPath();
  const backupPath = `${configPath}${CONFIG_BACKUP_SUFFIX}`;
  let unreadable = false;

  for (const filePath of [configPath, backupPath]) {
    try {
      const raw = readConfigRawFromPathSync(filePath);
      // Never log `raw` or throw it in error text — may contain secrets.
      const document = asRecord(JSON.parse(raw));
      if (!document) throw new Error('Invalid config document');
      return exposeSecretsForConsumers(migrateConfig(document as unknown as AppConfig));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') unreadable = true;
      // Swallow parse errors without logging file contents or secret-bearing messages.
    }
  }

  if (unreadable) {
    console.error('[config] config or backup could not be read; refusing to reset.');
    throw new Error('Config file is corrupt and no valid backup is available.');
  }
  return exposeSecretsForConsumers(createDefaultConfig());
}

/** @internal test/debug helper — redacted JSON only (never use for persistence). */
export function debugRedactedConfigJson(config: AppConfig): string {
  return redactSecretsInJson(config, 2);
}
