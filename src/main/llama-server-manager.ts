/**
 * Managed ``llama-server`` subprocesses: dynamic ports, shell commands from settings, health probes.
 */
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, promises as fs, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import * as net from 'net';
import path = require('path');

import type {
  AppConfig,
  ChatTemplateReasoningCaps,
  LlamaCppManaged,
  LlamaManagedRuntimeEndpoints,
  LlmModelProfile,
  LlamaServerStatusPayload,
  LlamaServerStatusResult,
  ManagedServerHealthState,
} from '../shared';
import {
  appendJinjaFlagToManagedChatCommand,
  detectShellQuotingPlatform,
  ensureManagedLlamaDefaultServerFlags,
  ensureManagedLlamaGemmaReasoningFormat,
  findLlmModelLocation,
  formatChatTemplateReasoningSummary,
  looksLikeLlamaModelDownload,
  managedLlamaCmdUsesHfRemoteModel,
  parseLlamaServerPropsNctx,
  parseLlamaServerPropsReasoning,
  parseManagedLlamaChatTemplateFile,
  prepareManagedLlamaShellCommand,
  promoteManagedSentinelNglToAuto,
} from '../shared';
import { loadConfigSync } from './config/load-save';
import { SecretValue, unwrapSecret } from '../shared/types/app-config';
import { openAiV1BaseToServerRoot } from './openai-compatible-models';
import { mainState } from './state';
import { getAppDataDir, getManagedLlamaServerPath, getRuntimeBinDir } from './paths';
import { childHasExited, killPidTree, killProcessTree } from './utils/kill-process-tree';
import { ingestElectronLog } from './log-ingest';
import { rewriteManagedLlamaCommand } from './runtime/dependency-manager';
import { syncRuntimeConfigToPython } from './python/workspace-sync';
import {
  clearCachedChatTemplateReasoning,
  getCachedChatTemplateReasoning,
  getCachedLlamaServerNctx,
  setCachedChatTemplateReasoning,
  setCachedLlamaServerNctx,
} from './chat-template-reasoning-cache';

const LLAMA_LOGGER = 'clara.electron.llama';

function logLlamaLifecycle(level: string, message: string): void {
  if (level === 'WARNING' || level === 'ERROR') {
    console.warn(`[llama] ${message}`);
  } else {
    console.log(`[llama] ${message}`);
  }
  void ingestElectronLog(level, LLAMA_LOGGER, message, 'electron');
}

/**
 * Split mixed newline / CR process output into complete lines.
 * Holds a trailing partial line until the next chunk or ``flush``.
 */
export function createLineBuffer(onLine: (line: string) => void): {
  push(chunk: string): void;
  flush(): void;
} {
  let pending = '';
  const emit = (raw: string): void => {
    const line = raw.replace(/\s+$/u, '');
    if (line) {
      onLine(line);
    }
  };
  return {
    push(chunk: string): void {
      if (!chunk) {
        return;
      }
      pending += chunk;
      const parts = pending.split(/\r\n|\n|\r/);
      pending = parts.pop() ?? '';
      for (const part of parts) {
        emit(part);
      }
    },
    flush(): void {
      if (!pending) {
        return;
      }
      emit(pending);
      pending = '';
    },
  };
}

type StreamKind = 'chat' | 'embed';

interface StreamBuf {
  lastChatStdout: string;
  lastEmbedStdout: string;
  lastChatStderr: string;
  lastEmbedStderr: string;
}

interface ManagedLlamaSlot {
  generation: number;
  abort: boolean;
  /** Chat ``/health`` succeeded; Python may use the chat URL. */
  chatReady: boolean;
  /** Chat and embed (if configured) passed ``/health``; UI may show running. */
  ready: boolean;
  chatProc: ChildProcess | undefined;
  embedProc: ChildProcess | undefined;
  chatPort: number;
  embedPort: number | undefined;
  chatHost: string;
  embedHost: string | undefined;
  chatHealthHost: string;
  embedHealthHost: string | undefined;
  chatSpawnError: Error | undefined;
  embedSpawnError: Error | undefined;
  logBuf: StreamBuf;
}

const running = new Map<string, ManagedLlamaSlot>();
let nextManagedLlamaGeneration = 1;

/** Short TTL so burst IPC status calls (renderer debounce + poll) reuse one /health probe round. */
const STATUS_CACHE_TTL_MS = 450;
let statusCache: { modelId: string; at: number; result: LlamaServerStatusPayload } | null = null;

function invalidateManagedStatusCache(modelId?: string): void {
  if (modelId == null || statusCache?.modelId === modelId) {
    statusCache = null;
  }
}

function sendToRenderer(channel: string, payload: unknown): void {
  try {
    mainState.mainWindow?.webContents.send(channel, payload);
  } catch {
    /* window gone */
  }
  if (channel === 'llama-server-lifecycle') {
    try {
      mainState.settingsWindow?.webContents.send(channel, payload);
    } catch {
      /* window gone */
    }
  }
}

function isCurrent(modelId: string, generation: number): boolean {
  const st = running.get(modelId);
  return !!st && st.generation === generation && !st.abort;
}

function slotMissingOrAborted(modelId: string, generation: number): boolean {
  return !isCurrent(modelId, generation);
}

function emptyLogBuf(): StreamBuf {
  return { lastChatStdout: '', lastEmbedStdout: '', lastChatStderr: '', lastEmbedStderr: '' };
}

function managedLlamaPidFile(): string {
  return path.join(getAppDataDir(), 'managed-llama.pids.json');
}

function persistManagedLlamaPids(): void {
  const pids: number[] = [];
  for (const st of running.values()) {
    if (st.chatProc?.pid) {
      pids.push(st.chatProc.pid);
    }
    if (st.embedProc?.pid) {
      pids.push(st.embedProc.pid);
    }
  }
  try {
    if (pids.length === 0) {
      rmSync(managedLlamaPidFile(), { force: true });
      return;
    }
    writeFileSync(managedLlamaPidFile(), JSON.stringify(pids), 'utf8');
  } catch {
    /* pidfile is best-effort */
  }
}

/**
 * Kill llama-server processes left over from a previous Clara session that did not
 * run ``will-quit`` (crash, Task Manager kill). Those orphans hold model weights
 * in RAM/VRAM after the UI is gone.
 */
export function reapOrphanManagedLlamaServers(): void {
  let pids: number[] = [];
  try {
    const raw = readFileSync(managedLlamaPidFile(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      pids = parsed.filter((n): n is number => typeof n === 'number' && n > 0);
    }
  } catch {
    return;
  }
  for (const pid of pids) {
    killPidTree(pid);
  }
  try {
    rmSync(managedLlamaPidFile(), { force: true });
  } catch {
    /* ignore */
  }
}

async function pickPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object' && addr.port) {
        const p = addr.port;
        srv.close(() => resolve(p));
      } else {
        srv.close();
        reject(new Error('Could not allocate TCP port'));
      }
    });
    srv.on('error', reject);
  });
}

/**
 * Probe address for managed ``/health``. Wildcard bind hosts are not fetchable on every OS.
 */
export function managedLlamaHealthHost(bindHost: string): string {
  const h = bindHost.trim().toLowerCase();
  if (
    !h ||
    h === '0.0.0.0' ||
    h === '*' ||
    h === '::' ||
    h === '[::]' ||
    h === '::0' ||
    h === '[::0]'
  ) {
    return '127.0.0.1';
  }
  return bindHost.trim();
}

/**
 * Effective OpenAI-compatible URLs for each **managed** llamacpp model (spawned subprocess).
 * Skips URL-only rows (no ``chatRunCommand``) so Python uses the persisted provider ``baseUrl``.
 * Real ports are published only after chat ``/health`` succeeds.
 */
export function getLlamaManagedRuntimeOverrides(config: AppConfig): Record<string, LlamaManagedRuntimeEndpoints> {
  const out: Record<string, LlamaManagedRuntimeEndpoints> = {};
  for (const p of config.llmProviders) {
    if (p.provider !== 'llamacpp') {
      continue;
    }
    for (const m of p.models) {
      if (!(m.llamaCppManaged?.chatRunCommand ?? '').trim()) {
        continue;
      }
      const st = running.get(m.id);
      if (st?.chatReady && st.chatPort) {
        out[m.id] = {
          baseUrl: `http://127.0.0.1:${st.chatPort}/v1`,
          embeddingsBaseUrl:
            st.embedPort != null ? `http://127.0.0.1:${st.embedPort}/v1` : '',
        };
      } else {
        out[m.id] = {
          baseUrl: 'http://127.0.0.1:0/v1',
          embeddingsBaseUrl: '',
        };
      }
    }
  }
  return out;
}

/** Push runtime config with managed overrides (call after start/stop/save). */
export async function syncWithManagedLlamaOverrides(config: AppConfig): Promise<void> {
  // Pass a getter so overrides are read at send time (after any in-flight sync completes),
  // reflecting live `running` state rather than a snapshot captured when this was called.
  await syncRuntimeConfigToPython(config, () => getLlamaManagedRuntimeOverrides(config));
}

function appendStdout(bucket: StreamBuf, which: StreamKind, chunk: string): void {
  if (!chunk) {
    return;
  }
  const sink = which === 'chat' ? 'lastChatStdout' : 'lastEmbedStdout';
  bucket[sink] = (bucket[sink] + chunk).slice(-2500);
}

function logTailForStream(bucket: StreamBuf, which: StreamKind): string {
  const out = which === 'chat' ? bucket.lastChatStdout : bucket.lastEmbedStdout;
  const err = which === 'chat' ? bucket.lastChatStderr : bucket.lastEmbedStderr;
  return redactSecrets(`${out}\n${err}`.slice(-12_000));
}

/**
 * Persisted ``customModelsDir`` is authoritative for managed ``llama-server`` so Hugging Face / llama cache
 * env vars match Settings → Model Manager even if the renderer IPC snapshot is stale. HF token may still
 * come from the in-memory config when entered but not saved yet.
 */
function modelManagerForManagedLlamaSpawn(config: AppConfig): AppConfig['modelManager'] {
  const disk = loadConfigSync().modelManager;
  const ipcTok = unwrapSecret(config.modelManager.huggingFaceToken).trim();
  const diskTok = unwrapSecret(disk.huggingFaceToken).trim();
  return {
    ...disk,
    huggingFaceToken: SecretValue.of(ipcTok || diskTok),
  };
}

/**
 * Active HF token values to scrub from log streams.
 * Refcounted across concurrent managed spawns / streams so a finished spawn never
 * clears a secret still needed by another running stream.
 */
const activeRedactSecrets = new Map<string, number>();

export function acquireRedactSecret(token: string): void {
  if (!token) {
    return;
  }
  activeRedactSecrets.set(token, (activeRedactSecrets.get(token) ?? 0) + 1);
}

export function releaseRedactSecret(token: string): void {
  if (!token) {
    return;
  }
  const n = activeRedactSecrets.get(token) ?? 0;
  if (n <= 1) {
    activeRedactSecrets.delete(token);
  } else {
    activeRedactSecrets.set(token, n - 1);
  }
}

export function redactSecretValue(text: string, secret: string): string {
  if (!text || !secret) {
    return text;
  }
  return text.split(secret).join('[REDACTED]');
}

/** Redact every HF token still referenced by a live managed stream. */
export function redactSecrets(text: string): string {
  if (!text || activeRedactSecrets.size === 0) {
    return text;
  }
  let out = text;
  for (const secret of activeRedactSecrets.keys()) {
    out = redactSecretValue(out, secret);
  }
  return out;
}

/**
 * Redact ``secret`` even when it is split across successive stream chunks.
 * Holds back only a proper prefix of ``secret`` at the chunk boundary so a
 * complete token is never split between emit and pending.
 */
export function createSecretChunkRedactor(secret: string): {
  push(chunk: string): string;
  flush(): string;
} {
  let pending = '';
  return {
    push(chunk: string): string {
      if (!chunk) {
        return '';
      }
      if (!secret) {
        return chunk;
      }
      const combined = pending + chunk;
      const maxHold = secret.length - 1;
      let hold = 0;
      for (let n = Math.min(maxHold, combined.length); n >= 1; n--) {
        if (secret.startsWith(combined.slice(-n))) {
          hold = n;
          break;
        }
      }
      pending = hold ? combined.slice(-hold) : '';
      const emit = combined.slice(0, combined.length - hold);
      return redactSecretValue(emit, secret);
    },
    flush(): string {
      if (!pending) {
        return '';
      }
      const rest = redactSecretValue(pending, secret);
      pending = '';
      return rest;
    },
  };
}

export function buildManagedLlamaSpawnEnv(config: AppConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Prefer managed runtime/bin when resolving a bare ``llama-server``.
  const runtimeBin = getRuntimeBinDir();
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  const prevPath = env[pathKey] || env.PATH || '';
  env[pathKey] = prevPath ? `${runtimeBin}${path.delimiter}${prevPath}` : runtimeBin;
  env.PATH = env[pathKey];
  // Thin llama-server builds load libllama-server-impl from the same directory.
  // Prepend runtime/bin so co-located libs resolve even if RUNPATH is stale
  // (e.g. absolute build-dir path left by a source compile).
  if (process.platform === 'linux') {
    const prev = env.LD_LIBRARY_PATH || '';
    env.LD_LIBRARY_PATH = prev ? `${runtimeBin}${path.delimiter}${prev}` : runtimeBin;
  } else if (process.platform === 'darwin') {
    const prev = env.DYLD_LIBRARY_PATH || '';
    env.DYLD_LIBRARY_PATH = prev ? `${runtimeBin}${path.delimiter}${prev}` : runtimeBin;
  }
  const mm = modelManagerForManagedLlamaSpawn(config);
  const customDir = mm.customModelsDir.trim();
  if (customDir) {
    // Keep managed `-hf` downloads and hub/GGUF resolution under the Model Manager directory.
    // llama.cpp also honors HF_HUB_CACHE; huggingface_hub uses HF_HUB_CACHE / HUGGINGFACE_HUB_CACHE.
    env.LLAMA_CACHE = customDir;
    env.HF_HUB_CACHE = customDir;
    env.HUGGINGFACE_HUB_CACHE = customDir;
    env.TRANSFORMERS_CACHE = customDir;
    // A user/system HF_HOME makes llama.cpp resolve $HF_HOME/hub and ignore the dirs above in some builds.
    delete env.HF_HOME;
  }
  // Never inherit parent HF tokens; re-inject only from Model Manager settings.
  delete env.HF_TOKEN;
  delete env.HUGGING_FACE_HUB_TOKEN;
  delete env.HUGGINGFACE_HUB_TOKEN;
  const tok = mm.huggingFaceToken.trim();
  if (tok) {
    env.HF_TOKEN = tok;
    env.HUGGING_FACE_HUB_TOKEN = tok;
  }
  return env;
}

/** Disallowed shell metacharacters (unquoted tokens; newlines are rejected on the full string). */
export const MANAGED_LLAMA_SHELL_METACHAR_RE = /[;|&<>`$(){}!*\n\r~#]/;
const UNQUOTED_TOKEN_METACHAR_RE = /[;|&<>`$(){}!*~#]/;

/**
 * Tokenize a prepared managed run command into argv.
 * Honors single/double quotes; rejects unbalanced quotes and unquoted shell metacharacters.
 * Quoted tokens may contain path characters such as ``()`` (e.g. ``Program Files (x86)``).
 */
export function tokenizeManagedLlamaCommand(
  command: string,
): { ok: true; argv: string[] } | { ok: false; error: string } {
  if (/[\n\r]/.test(command)) {
    return {
      ok: false,
      error:
        'Run command contains disallowed shell metacharacters (; | & < > ` $ ( ) { } ! * # ~ or newlines).',
    };
  }
  const argv: string[] = [];
  let i = 0;
  const s = command;
  while (i < s.length) {
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) {
      i++;
    }
    if (i >= s.length) {
      break;
    }
    const q = s[i];
    if (q === '"' || q === "'") {
      i++;
      let token = '';
      let closed = false;
      while (i < s.length) {
        if (s[i] === q) {
          closed = true;
          i++;
          break;
        }
        token += s[i];
        i++;
      }
      if (!closed) {
        return { ok: false, error: 'Run command has unbalanced quotes.' };
      }
      argv.push(token);
      continue;
    }
    let token = '';
    while (i < s.length && s[i] !== ' ' && s[i] !== '\t' && s[i] !== '"' && s[i] !== "'") {
      token += s[i];
      i++;
    }
    // Reject shell-style adjacent quotes (e.g. --chat-template-file="/path with spaces").
    // Supported forms: --flag value, --flag=/path (no spaces), or a fully quoted token.
    if (i < s.length && (s[i] === '"' || s[i] === "'")) {
      return {
        ok: false,
        error:
          'Run command has quotes adjacent to an unquoted token (e.g. --flag="value"). Use --flag value or --flag=value without adjacent quotes.',
      };
    }
    if (UNQUOTED_TOKEN_METACHAR_RE.test(token)) {
      return {
        ok: false,
        error:
          'Run command contains disallowed shell metacharacters (; | & < > ` $ ( ) { } ! * # ~ or newlines).',
      };
    }
    argv.push(token);
  }
  if (argv.length === 0) {
    return { ok: false, error: 'Run command is empty.' };
  }
  return { ok: true, argv };
}

/**
 * Allow only the managed runtime ``llama-server`` binary under the real runtime/bin directory.
 * Resolves symlinks so a symlink inside bin/ cannot point outside the allowlist.
 */
export function resolveAllowedManagedLlamaServerBinary(
  binPath: string,
): { ok: true; bin: string } | { ok: false; error: string } {
  const resolved = path.resolve(binPath);
  let realBin: string;
  try {
    realBin = realpathSync(resolved);
  } catch {
    return {
      ok: false,
      error:
        'Run command binary must be the managed llama-server under the Clara runtime bin directory.',
    };
  }
  let realBinDir: string;
  try {
    realBinDir = realpathSync(path.resolve(getRuntimeBinDir()));
  } catch {
    return {
      ok: false,
      error:
        'Run command binary must be the managed llama-server under the Clara runtime bin directory.',
    };
  }
  if (path.dirname(realBin) !== realBinDir) {
    return {
      ok: false,
      error:
        'Run command binary must be the managed llama-server under the Clara runtime bin directory.',
    };
  }
  const base = path.basename(realBin);
  if (base !== 'llama-server' && base !== 'llama-server.exe') {
    return {
      ok: false,
      error:
        'Run command binary must be the managed llama-server under the Clara runtime bin directory.',
    };
  }
  return { ok: true, bin: realBin };
}

/**
 * Derive argv from a ``prepareManagedLlamaShellCommand`` result and validate the binary allowlist.
 */
export function managedLlamaCommandToSpawnArgv(
  command: string,
): { ok: true; bin: string; args: string[] } | { ok: false; error: string } {
  const tok = tokenizeManagedLlamaCommand(command);
  if (!tok.ok) {
    return tok;
  }
  const [bin, ...args] = tok.argv;
  if (!bin) {
    return { ok: false, error: 'Run command is empty.' };
  }
  const allowed = resolveAllowedManagedLlamaServerBinary(bin);
  if (!allowed.ok) {
    return allowed;
  }
  return { ok: true, bin: allowed.bin, args };
}

function hfWarmHintFromLogs(logBuf: StreamBuf, kind: StreamKind): string {
  const t = logTailForStream(logBuf, kind).toLowerCase();
  if (
    /401|hf_token|hf token|hugging\s*face|gated model|model is private|private or does not exist|provide a valid hf token|invalid credentials/.test(
      t,
    )
  ) {
    return ' Hugging Face rejected the request (often HTTP 401 for gated or private repos). Set a read token in Clara → Settings → Model Manager → Hugging Face token (used when you Start managed servers), or set HF_TOKEN in your user environment.';
  }
  if (/repository not found|"error":\s*"repository not found"|manifests\//i.test(t)) {
    return ' Hugging Face returned 404 (unknown repo, branch, or manifest/quantization tag in your chat `-hf` command). Fix chat first: the embedding server starts only after chat is healthy, so a bad chat preset used to abort an embed download mid-way.';
  }
  if (/head failed,\s*status:\s*404|no remote preset found/.test(t)) {
    return ' A remote preset or file returned 404—verify the model id and file name. Some downloads still require a Hugging Face token.';
  }
  return '';
}

function appendStderrQuiet(bucket: StreamBuf, which: StreamKind, chunk: string): void {
  if (!chunk) {
    return;
  }
  const sink = which === 'chat' ? 'lastChatStderr' : 'lastEmbedStderr';
  bucket[sink] = (bucket[sink] + chunk).slice(-4000);
}

function attachLlamaStreams(
  modelId: string,
  which: StreamKind,
  proc: ChildProcess,
  bucket: StreamBuf,
  hfToken: string,
): void {
  acquireRedactSecret(hfToken);
  const stdoutRedact = createSecretChunkRedactor(hfToken);
  const stderrRedact = createSecretChunkRedactor(hfToken);
  proc.stdout?.on('data', (d: Buffer) => {
    const s = stdoutRedact.push(d.toString());
    if (!s) {
      return;
    }
    appendStdout(bucket, which, s);
    sendToRenderer('llama-server-output', { modelId, stream: which, fd: 'stdout', data: s });
  });
  proc.stderr?.on('data', (d: Buffer) => {
    const s = stderrRedact.push(d.toString());
    if (!s) {
      return;
    }
    appendStderrQuiet(bucket, which, s);
    sendToRenderer('llama-server-output', { modelId, stream: which, fd: 'stderr', data: s });
  });
  proc.on('error', (err: Error) => {
    logLlamaLifecycle(
      'ERROR',
      `${which} llama-server spawn error modelId=${modelId} pid=${proc.pid ?? '?'} error=${err.message}`,
    );
  });
  proc.on('exit', (code, signal) => {
    const flushedOut = stdoutRedact.flush();
    if (flushedOut) {
      appendStdout(bucket, which, flushedOut);
      sendToRenderer('llama-server-output', { modelId, stream: which, fd: 'stdout', data: flushedOut });
    }
    const flushedErr = stderrRedact.flush();
    if (flushedErr) {
      appendStderrQuiet(bucket, which, flushedErr);
      sendToRenderer('llama-server-output', { modelId, stream: which, fd: 'stderr', data: flushedErr });
    }
    releaseRedactSecret(hfToken);
    const st = running.get(modelId);
    const unexpected =
      which === 'chat' ? !!(st && st.chatProc === proc) : !!(st && st.embedProc === proc);
    const level = unexpected && code !== 0 ? 'WARNING' : 'INFO';
    logLlamaLifecycle(
      level,
      `${which} llama-server process exited modelId=${modelId} pid=${proc.pid ?? '?'} ` +
        `code=${code} signal=${signal ?? ''} unexpected=${unexpected}`,
    );
    sendToRenderer('llama-server-process-exit', {
      modelId,
      stream: which,
      code,
      signal: signal != null ? String(signal) : null,
    });
    // Chat death ends the managed pair. Intentional stop deletes from ``running`` first
    // so this path only runs on unexpected exit (or a race after stop).
    if (which === 'chat') {
      if (unexpected) {
        stopManagedLlamaServers(modelId);
      }
      return;
    }
    if (!unexpected || !st) {
      return;
    }
    st.embedProc = undefined;
    st.embedPort = undefined;
    st.embedHost = undefined;
    st.embedHealthHost = undefined;
    invalidateManagedStatusCache(modelId);
    if (st.ready) {
      try {
        void syncWithManagedLlamaOverrides(loadConfigSync());
      } catch {
        /* config unavailable */
      }
    }
  });
}

function reserveManagedLlamaSlot(modelId: string): ManagedLlamaSlot {
  const slot: ManagedLlamaSlot = {
    generation: nextManagedLlamaGeneration++,
    abort: false,
    chatReady: false,
    ready: false,
    chatProc: undefined,
    embedProc: undefined,
    chatPort: 0,
    embedPort: undefined,
    chatHost: '127.0.0.1',
    embedHost: undefined,
    chatHealthHost: '127.0.0.1',
    embedHealthHost: undefined,
    chatSpawnError: undefined,
    embedSpawnError: undefined,
    logBuf: emptyLogBuf(),
  };
  running.set(modelId, slot);
  return slot;
}

function failStart(modelId: string, generation: number, error: string): { ok: false; error: string } {
  logLlamaLifecycle('ERROR', `start failed modelId=${modelId}: ${error}`);
  const st = running.get(modelId);
  if (st && st.generation === generation) {
    stopManagedLlamaServers(modelId);
  }
  return { ok: false, error };
}

const STOPPED_DURING_START = 'Managed servers were stopped.';

export async function startManagedLlamaServers(modelId: string, config: AppConfig): Promise<{ ok: true } | { ok: false; error: string }> {
  if (running.has(modelId)) {
    return { ok: false, error: 'Managed servers already running for this model preset.' };
  }
  invalidateManagedStatusCache();
  const loc = findLlmModelLocation(config.llmProviders, modelId);
  if (!loc || loc.provider.provider !== 'llamacpp') {
    return { ok: false, error: 'Not a llama.cpp model preset.' };
  }
  const managed: LlamaCppManaged | undefined = loc.model.llamaCppManaged;
  if (!managed) {
    return { ok: false, error: 'Missing llamaCppManaged profile.' };
  }

  const managedLlamaBin = getManagedLlamaServerPath();
  let chatCmd = promoteManagedSentinelNglToAuto(
    rewriteManagedLlamaCommand((managed.chatRunCommand || '').trim(), managedLlamaBin),
    detectShellQuotingPlatform(),
  );
  if (!chatCmd) {
    return { ok: false, error: 'chatRunCommand is empty.' };
  }
  if (/^(["']?)llama-server(?:\.exe)?\1(\s|$)/i.test(chatCmd) && !managedLlamaBin) {
    return {
      ok: false,
      error:
        'llama-server is not installed. Open Dependencies and download “llama-server”, or set a full path in the run command.',
    };
  }

  chatCmd = ensureManagedLlamaDefaultServerFlags(appendJinjaFlagToManagedChatCommand(chatCmd));
  if ((loc.model.optimizationPreset || '').trim().toLowerCase() === 'gemma') {
    chatCmd = ensureManagedLlamaGemmaReasoningFormat(chatCmd);
  }
  const chatTemplateFile = parseManagedLlamaChatTemplateFile(chatCmd);
  if (chatTemplateFile && !existsSync(chatTemplateFile)) {
    return {
      ok: false,
      error: `Chat template file was not found at ${chatTemplateFile}. Clear Chat template in Settings to use the GGUF template, or pick a valid .jinja file.`,
    };
  }

  const embedCmd = rewriteManagedLlamaCommand((managed.embeddingRunCommand || '').trim(), managedLlamaBin);

  if (running.has(modelId)) {
    return { ok: false, error: 'Managed servers already running for this model preset.' };
  }
  const slot = reserveManagedLlamaSlot(modelId);
  const generation = slot.generation;
  sendToRenderer('llama-server-lifecycle', { phase: 'starting', modelId });
  logLlamaLifecycle('INFO', `starting managed llama-server modelId=${modelId}`);

  const spawnEnv = buildManagedLlamaSpawnEnv(config);
  const hfToken = modelManagerForManagedLlamaSpawn(config).huggingFaceToken.trim();

  try {
    const managedCacheDir = (spawnEnv.LLAMA_CACHE || '').trim();
    if (managedCacheDir) {
      await fs.mkdir(managedCacheDir, { recursive: true });
    }
    if (slotMissingOrAborted(modelId, generation)) {
      return { ok: false, error: STOPPED_DURING_START };
    }

    const chatPort = await pickPort();
    if (slotMissingOrAborted(modelId, generation)) {
      return { ok: false, error: STOPPED_DURING_START };
    }
    let embedPort: number | undefined;
    if (embedCmd) {
      embedPort = await pickPort();
      if (embedPort === chatPort) {
        return failStart(modelId, generation, 'Could not allocate two distinct ports.');
      }
    }
    if (slotMissingOrAborted(modelId, generation)) {
      return { ok: false, error: STOPPED_DURING_START };
    }

    const chatBuilt = prepareManagedLlamaShellCommand(chatCmd, chatPort);
    if (!chatBuilt.ok) {
      return failStart(modelId, generation, chatBuilt.error);
    }

    let embedBuilt: { command: string; host: string } | undefined;
    if (embedCmd && embedPort != null) {
      const eb = prepareManagedLlamaShellCommand(embedCmd, embedPort);
      if (!eb.ok) {
        return failStart(modelId, generation, eb.error);
      }
      embedBuilt = { command: eb.command, host: eb.host };
    }

    const chatArgv = managedLlamaCommandToSpawnArgv(chatBuilt.command);
    if (!chatArgv.ok) {
      return failStart(modelId, generation, chatArgv.error);
    }
    let embedArgv: { bin: string; args: string[] } | undefined;
    if (embedBuilt) {
      const ea = managedLlamaCommandToSpawnArgv(embedBuilt.command);
      if (!ea.ok) {
        return failStart(modelId, generation, ea.error);
      }
      embedArgv = { bin: ea.bin, args: ea.args };
    }
    if (slotMissingOrAborted(modelId, generation)) {
      return { ok: false, error: STOPPED_DURING_START };
    }

    const st = running.get(modelId);
    if (!st || st.generation !== generation) {
      return { ok: false, error: STOPPED_DURING_START };
    }
    st.chatPort = chatPort;
    st.chatHost = chatBuilt.host;
    st.chatHealthHost = managedLlamaHealthHost(chatBuilt.host);

    /**
     * Start chat first and wait for ``/health`` before spawning embedding.
     * If chat fails (e.g. wrong ``-hf`` / 404), we must not have started embed yet—otherwise
     * ``stopManagedLlamaServers`` would kill a long embed download that was never going to be used.
     */
    const chatProc = spawn(chatArgv.bin, chatArgv.args, {
      /** POSIX: new process group so ``kill(-pid)`` stops ``llama-server`` (no shell). */
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: spawnEnv,
    });
    st.chatProc = chatProc;
    persistManagedLlamaPids();
    attachLlamaStreams(modelId, 'chat', chatProc, st.logBuf, hfToken);
    logLlamaLifecycle(
      'INFO',
      `spawned chat llama-server modelId=${modelId} pid=${chatProc.pid ?? '?'} port=${chatPort}`,
    );
    chatProc.on('error', (err: Error) => {
      const cur = running.get(modelId);
      if (cur && cur.generation === generation && cur.chatProc === chatProc) {
        cur.chatSpawnError = err;
      }
    });

    const chatBudgetMs = managedLlamaCmdUsesHfRemoteModel(chatCmd) ? HEALTH_WAIT_HF_CMD_MS : HEALTH_WAIT_DEFAULT_MS;
    const chatWait = await waitForHealth(st.chatHealthHost, chatPort, chatBudgetMs, {
      proc: chatProc,
      getLogTail: () => logTailForStream(st.logBuf, 'chat'),
      modelId,
      generation,
      spawnError: () => running.get(modelId)?.chatSpawnError,
    });
    if (slotMissingOrAborted(modelId, generation)) {
      return { ok: false, error: STOPPED_DURING_START };
    }
    if (chatWait !== 'ok') {
      if (chatWait === 'spawn_error') {
        const err = st.chatSpawnError;
        return failStart(
          modelId,
          generation,
          err ? `Chat llama-server failed to start (${err.message}).` : 'Chat llama-server failed to start.',
        );
      }
      if (chatWait === 'exited') {
        return failStart(modelId, generation, shortEarlyExitError('Chat', chatProc, st.logBuf, 'chat'));
      }
      return failStart(
        modelId,
        generation,
        `Chat llama-server did not become healthy in time (no HTTP 200 from http://${st.chatHealthHost}:${chatPort}/health). See the llama.cpp server terminal tab for output.`,
      );
    }

    st.chatReady = true;
    invalidateManagedStatusCache(modelId);
    await ensureChatTemplateReasoning(modelId, st.chatHealthHost, chatPort);
    if (slotMissingOrAborted(modelId, generation)) {
      return { ok: false, error: STOPPED_DURING_START };
    }
    await syncWithManagedLlamaOverrides(config);
    if (slotMissingOrAborted(modelId, generation)) {
      return { ok: false, error: STOPPED_DURING_START };
    }

    if (embedBuilt && embedPort != null && embedArgv) {
      const stEmbed = running.get(modelId);
      if (!stEmbed || stEmbed.generation !== generation) {
        return { ok: false, error: STOPPED_DURING_START };
      }
      stEmbed.embedPort = embedPort;
      stEmbed.embedHost = embedBuilt.host;
      stEmbed.embedHealthHost = managedLlamaHealthHost(embedBuilt.host);
      const embedProc = spawn(embedArgv.bin, embedArgv.args, {
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: spawnEnv,
      });
      stEmbed.embedProc = embedProc;
      persistManagedLlamaPids();
      attachLlamaStreams(modelId, 'embed', embedProc, stEmbed.logBuf, hfToken);
      logLlamaLifecycle(
        'INFO',
        `spawned embed llama-server modelId=${modelId} pid=${embedProc.pid ?? '?'} port=${embedPort}`,
      );
      embedProc.on('error', (err: Error) => {
        const cur = running.get(modelId);
        if (cur && cur.generation === generation && cur.embedProc === embedProc) {
          cur.embedSpawnError = err;
        }
      });
      invalidateManagedStatusCache(modelId);

      const embedBudgetMs = managedLlamaCmdUsesHfRemoteModel(embedCmd) ? HEALTH_WAIT_HF_CMD_MS : HEALTH_WAIT_DEFAULT_MS;
      const embWait = await waitForHealth(stEmbed.embedHealthHost ?? '127.0.0.1', embedPort, embedBudgetMs, {
        proc: embedProc,
        getLogTail: () => logTailForStream(stEmbed.logBuf, 'embed'),
        modelId,
        generation,
        spawnError: () => running.get(modelId)?.embedSpawnError,
      });
      if (slotMissingOrAborted(modelId, generation)) {
        return { ok: false, error: STOPPED_DURING_START };
      }
      if (embWait !== 'ok') {
        if (embWait === 'spawn_error') {
          const err = stEmbed.embedSpawnError;
          return failStart(
            modelId,
            generation,
            err
              ? `Embedding llama-server failed to start (${err.message}).`
              : 'Embedding llama-server failed to start.',
          );
        }
        if (embWait === 'exited') {
          return failStart(modelId, generation, shortEarlyExitError('Embedding', embedProc, stEmbed.logBuf, 'embed'));
        }
        return failStart(
          modelId,
          generation,
          'Embedding llama-server did not become healthy in time. See the llama.cpp server terminal tab for output.',
        );
      }
    }

    const stDone = running.get(modelId);
    if (!stDone || stDone.generation !== generation || stDone.abort) {
      return { ok: false, error: STOPPED_DURING_START };
    }
    stDone.ready = true;
    await syncWithManagedLlamaOverrides(config);
    if (slotMissingOrAborted(modelId, generation)) {
      return { ok: false, error: STOPPED_DURING_START };
    }
    sendToRenderer('llama-server-lifecycle', {
      phase: 'running',
      modelId,
      chatTemplateReasoning: getCachedChatTemplateReasoning(modelId),
      nCtx: getCachedLlamaServerNctx(modelId),
    });
    logLlamaLifecycle(
      'INFO',
      `running managed llama-server modelId=${modelId} chat=${stDone.chatHealthHost}:${stDone.chatPort}` +
        (stDone.embedPort != null ? ` embedPort=${stDone.embedPort}` : ''),
    );
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return failStart(modelId, generation, msg);
  }
}

function shortEarlyExitError(label: string, proc: ChildProcess, logBuf: StreamBuf, kind: StreamKind): string {
  const code = proc.exitCode;
  const sig = proc.signalCode;
  const why =
    code !== null ? `exit ${code}` : sig != null ? `signal ${sig}` : 'exited unexpectedly';
  return `${label} llama-server process ended (${why}). See the llama.cpp server terminal tab for process output.${hfWarmHintFromLogs(logBuf, kind)}`;
}

function fetchWithTimeout(url: string, ms: number, init?: RequestInit): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return fetch(url, { ...init, signal: ac.signal }).finally(() => clearTimeout(t));
}

const PROPS_FETCH_TIMEOUT_MS = 2000;
const PROPS_RETRY_MS = 15_000;
const propsFetchInFlight = new Map<string, Promise<ChatTemplateReasoningCaps | undefined>>();
const propsFetchFailedAt = new Map<string, number>();

function attachCachedReasoning(
  payload: LlamaServerStatusPayload,
): LlamaServerStatusPayload {
  const caps = getCachedChatTemplateReasoning(payload.modelId);
  const nCtx = getCachedLlamaServerNctx(payload.modelId);
  return {
    ...payload,
    ...(caps ? { chatTemplateReasoning: caps } : {}),
    ...(nCtx != null ? { nCtx } : {}),
  };
}

type LlamaPropsFetchOpts = {
  /** Full llama-server origin (preserves http/https). Used for remote URL-only rows. */
  serverRoot?: string;
  apiKey?: string;
};

function llamaPropsUrl(host: string, port: number, serverRoot?: string): string {
  const root = (serverRoot || '').trim().replace(/\/+$/, '');
  if (root) {
    return `${root}/props`;
  }
  return `http://${host}:${port}/props`;
}

function llamaAuthHeaders(apiKey?: string): Record<string, string> | undefined {
  const key = (apiKey || '').trim();
  if (!key) {
    return undefined;
  }
  return { Authorization: `Bearer ${key}` };
}

async function fetchChatTemplateReasoningOnce(
  modelId: string,
  host: string,
  port: number,
  opts?: LlamaPropsFetchOpts,
): Promise<ChatTemplateReasoningCaps | undefined> {
  const url = llamaPropsUrl(host, port, opts?.serverRoot);
  const headers = llamaAuthHeaders(opts?.apiKey);
  logLlamaLifecycle('INFO', `fetching chat template modelId=${modelId} url=${url}`);
  try {
    const res = await fetchWithTimeout(url, PROPS_FETCH_TIMEOUT_MS, headers ? { headers } : undefined);
    if (!res.ok) {
      logLlamaLifecycle(
        'WARNING',
        `chat template fetch failed modelId=${modelId} error=HTTP ${res.status}`,
      );
      propsFetchFailedAt.set(modelId, Date.now());
      return undefined;
    }
    const body: unknown = await res.json();
    const nCtx = parseLlamaServerPropsNctx(body);
    if (nCtx != null) {
      setCachedLlamaServerNctx(modelId, nCtx);
      logLlamaLifecycle('INFO', `loaded n_ctx modelId=${modelId} n_ctx=${nCtx}`);
    }
    const parsed = parseLlamaServerPropsReasoning(body);
    if (parsed.missingTemplate) {
      logLlamaLifecycle('WARNING', `chat template missing modelId=${modelId}`);
      propsFetchFailedAt.set(modelId, Date.now());
      if (nCtx != null) {
        try {
          void syncWithManagedLlamaOverrides(loadConfigSync());
        } catch {
          /* config unavailable */
        }
      }
      return undefined;
    }
    setCachedChatTemplateReasoning(modelId, parsed.caps);
    propsFetchFailedAt.delete(modelId);
    try {
      void syncWithManagedLlamaOverrides(loadConfigSync());
    } catch {
      /* config unavailable */
    }
    logLlamaLifecycle(
      'INFO',
      `chat template reasoning modelId=${modelId} ${formatChatTemplateReasoningSummary(parsed.caps)} bytes=${parsed.templateBytes}` +
        (nCtx != null ? ` n_ctx=${nCtx}` : ''),
    );
    return parsed.caps;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logLlamaLifecycle('WARNING', `chat template fetch failed modelId=${modelId} error=${msg}`);
    propsFetchFailedAt.set(modelId, Date.now());
    return undefined;
  }
}

async function ensureChatTemplateReasoning(
  modelId: string,
  host: string,
  port: number,
  opts?: LlamaPropsFetchOpts,
): Promise<ChatTemplateReasoningCaps | undefined> {
  const cached = getCachedChatTemplateReasoning(modelId);
  if (cached) {
    return cached;
  }
  const failedAt = propsFetchFailedAt.get(modelId);
  if (failedAt != null && Date.now() - failedAt < PROPS_RETRY_MS) {
    return undefined;
  }
  const inflight = propsFetchInFlight.get(modelId);
  if (inflight) {
    return inflight;
  }
  const p = fetchChatTemplateReasoningOnce(modelId, host, port, opts).finally(() => {
    propsFetchInFlight.delete(modelId);
  });
  propsFetchInFlight.set(modelId, p);
  return p;
}

function kickChatTemplateReasoningIfMissing(
  modelId: string,
  host: string,
  port: number,
  opts?: LlamaPropsFetchOpts,
): void {
  if (getCachedChatTemplateReasoning(modelId) || propsFetchInFlight.has(modelId)) {
    return;
  }
  void ensureChatTemplateReasoning(modelId, host, port, opts).then(() => {
    invalidateManagedStatusCache(modelId);
  });
}

type HealthWait = 'ok' | 'timeout' | 'exited' | 'spawn_error' | 'aborted';

interface HealthWaitContext {
  proc?: ChildProcess;
  /** Recent stdout+stderr for this stream (used to detect long HF / model downloads). */
  getLogTail?: () => string;
  modelId?: string;
  generation?: number;
  spawnError?: () => Error | undefined;
}

const HEALTH_POLL_MS = 500;
/** Default wait when the command does not look like a remote HF pull (local GGUF load). */
const HEALTH_WAIT_DEFAULT_MS = 600_000;
/** First-time ``-hf`` pulls can take a long time; keep polling until ready or hard cap. */
const HEALTH_WAIT_HF_CMD_MS = 50 * 60 * 1000;
/** Never block longer than this from ``start`` even if logs keep matching download heuristics. */
const HEALTH_WAIT_HARD_CAP_MS = 58 * 60 * 1000;
/** When download-like logs appear, extend the soft deadline by this much (capped by hard cap). */
const HEALTH_EXTEND_ON_DOWNLOAD_MS = 22 * 60 * 1000;

async function waitForHealth(
  host: string,
  port: number,
  initialBudgetMs: number,
  ctx?: HealthWaitContext,
): Promise<HealthWait> {
  const startedAt = Date.now();
  const hardCap = startedAt + HEALTH_WAIT_HARD_CAP_MS;
  let deadline = startedAt + Math.min(initialBudgetMs, HEALTH_WAIT_HARD_CAP_MS);
  let downloadLifecycleSent = false;

  while (Date.now() < Math.min(deadline, hardCap)) {
    if (ctx?.modelId != null && ctx.generation != null && slotMissingOrAborted(ctx.modelId, ctx.generation)) {
      return 'aborted';
    }
    if (ctx?.spawnError?.()) {
      return 'spawn_error';
    }
    if (ctx?.proc && childHasExited(ctx.proc)) {
      return 'exited';
    }
    try {
      const res = await fetchWithTimeout(`http://${host}:${port}/health`, 2000);
      if (res.ok) {
        if (ctx?.modelId != null && ctx.generation != null && slotMissingOrAborted(ctx.modelId, ctx.generation)) {
          return 'aborted';
        }
        return 'ok';
      }
    } catch {
      /* still loading or not listening yet */
    }

    const tail = ctx?.getLogTail?.() ?? '';
    if (tail && looksLikeLlamaModelDownload(tail)) {
      if (!downloadLifecycleSent && ctx?.modelId) {
        downloadLifecycleSent = true;
        sendToRenderer('llama-server-lifecycle', { phase: 'downloading', modelId: ctx.modelId });
      }
      deadline = Math.min(hardCap, Math.max(deadline, Date.now() + HEALTH_EXTEND_ON_DOWNLOAD_MS));
    }

    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  if (ctx?.modelId != null && ctx.generation != null && slotMissingOrAborted(ctx.modelId, ctx.generation)) {
    return 'aborted';
  }
  if (ctx?.spawnError?.()) {
    return 'spawn_error';
  }
  if (ctx?.proc && childHasExited(ctx.proc)) {
    return 'exited';
  }
  return 'timeout';
}

export function stopManagedLlamaServers(modelId: string): void {
  const st = running.get(modelId);
  if (!st) {
    return;
  }
  st.abort = true;
  invalidateManagedStatusCache(modelId);
  // Remove before kill so the chat ``exit`` handler does not treat this as unexpected death.
  running.delete(modelId);
  clearCachedChatTemplateReasoning(modelId);
  propsFetchFailedAt.delete(modelId);
  sendToRenderer('llama-server-lifecycle', { phase: 'stopped', modelId });
  logLlamaLifecycle(
    'INFO',
    `stopped managed llama-server modelId=${modelId} chatPid=${st.chatProc?.pid ?? ''} embedPid=${st.embedProc?.pid ?? ''}`,
  );
  killProcessTree(st.embedProc);
  killProcessTree(st.chatProc);
  persistManagedLlamaPids();
  // Retract the published runtime overrides so Python stops targeting a dead URL.
  // Every teardown path (manual stop, chat crash, prune, embed-fail) must sync.
  try {
    void syncWithManagedLlamaOverrides(loadConfigSync());
  } catch {
    /* config unavailable */
  }
}

/** Drop map entries whose chat process has already exited (belt-and-suspenders). */
function pruneDeadManagedLlamaEntries(): void {
  for (const [modelId, st] of [...running.entries()]) {
    if (!st.chatProc || !childHasExited(st.chatProc)) {
      continue;
    }
    logLlamaLifecycle('WARNING', `pruned dead managed llama-server modelId=${modelId}`);
    stopManagedLlamaServers(modelId);
  }
}

function healthSeverity(h: ManagedServerHealthState): number {
  switch (h) {
    case 'error':
      return 3;
    case 'loading':
      return 2;
    case 'ok':
      return 1;
    case 'stopped':
    default:
      return 0;
  }
}

/** Aggregate view for Health window (no modelId required). */
export type ManagedLlamaRuntimeSummary = {
  binaryInstalled: boolean;
  runningCount: number;
  health: ManagedServerHealthState;
  modelIds: string[];
};

/** Worst chat /health among live managed servers; prunes crashed chat procs first. */
export async function summarizeManagedLlamaRuntime(): Promise<ManagedLlamaRuntimeSummary> {
  pruneDeadManagedLlamaEntries();
  const binaryInstalled = !!getManagedLlamaServerPath();
  const entries = [...running.entries()];
  if (entries.length === 0) {
    return { binaryInstalled, runningCount: 0, health: 'stopped', modelIds: [] };
  }
  const healths = await Promise.all(
    entries.map(async ([, st]): Promise<ManagedServerHealthState> => {
      if (!st.chatProc) {
        return 'loading';
      }
      if (childHasExited(st.chatProc)) {
        return 'error';
      }
      if (!st.chatReady || !st.chatPort) {
        return 'loading';
      }
      return probeOnce(st.chatHealthHost, st.chatPort);
    }),
  );
  let worst: ManagedServerHealthState = 'ok';
  for (const h of healths) {
    if (healthSeverity(h) > healthSeverity(worst)) {
      worst = h;
    }
  }
  pruneDeadManagedLlamaEntries();
  const modelIds = [...running.keys()];
  if (modelIds.length === 0) {
    return { binaryInstalled, runningCount: 0, health: 'stopped', modelIds };
  }
  return { binaryInstalled, runningCount: modelIds.length, health: worst, modelIds };
}

export function stopAllManagedLlamaServers(): void {
  for (const id of [...running.keys()]) {
    stopManagedLlamaServers(id);
  }
}

async function probeOnce(host: string, port: number): Promise<ManagedServerHealthState> {
  const once = async (): Promise<ManagedServerHealthState> => {
    try {
      const res = await fetchWithTimeout(`http://${host}:${port}/health`, 1500);
      return res.ok ? 'ok' : 'loading';
    } catch {
      return 'error';
    }
  };
  const first = await once();
  if (first === 'ok') {
    return 'ok';
  }
  await new Promise<void>((r) => setTimeout(r, 120));
  const second = await once();
  if (second === 'ok') {
    return 'ok';
  }
  if (first === 'loading' || second === 'loading') {
    return 'loading';
  }
  return 'error';
}

function httpPortForDisplay(rootUrl: string): number {
  try {
    const u = new URL(rootUrl);
    if (u.port) {
      return Number.parseInt(u.port, 10) || 0;
    }
    return u.protocol === 'https:' ? 443 : 80;
  } catch {
    return 0;
  }
}

async function getRemoteLlamacppUrlStatus(
  modelId: string,
  openAiV1BaseUrl: string,
  embeddingsOpenAiV1BaseUrl?: string,
  apiKey?: string,
): Promise<LlamaServerStatusResult> {
  const root = openAiV1BaseToServerRoot(openAiV1BaseUrl);
  if (!root) {
    return {
      ok: true,
      remote: true,
      running: false,
      modelId,
      chat: { port: 0, health: 'error' },
    };
  }
  const embIn = (embeddingsOpenAiV1BaseUrl ?? '').trim();
  const embRoot = embIn ? openAiV1BaseToServerRoot(embIn) : '';
  const headers = llamaAuthHeaders(apiKey);

  const probeHttpHealth = async (baseRoot: string): Promise<ManagedServerHealthState> => {
    try {
      const res = await fetchWithTimeout(`${baseRoot}/health`, 2000, headers ? { headers } : undefined);
      return res.ok ? 'ok' : 'error';
    } catch {
      return 'error';
    }
  };

  const chatP = probeHttpHealth(root);
  const embedP =
    embRoot !== ''
      ? probeHttpHealth(embRoot).then((health) => ({
          port: httpPortForDisplay(embRoot),
          health,
        }))
      : Promise.resolve(undefined);

  const [chatHealth, embedBlock] = await Promise.all([chatP, embedP]);
  const port = httpPortForDisplay(root);
  try {
    const u = new URL(root);
    const host = managedLlamaHealthHost(u.hostname);
    if (chatHealth === 'ok' && host && port > 0) {
      await ensureChatTemplateReasoning(modelId, host, port, { serverRoot: root, apiKey });
    } else {
      clearCachedChatTemplateReasoning(modelId);
      propsFetchFailedAt.delete(modelId);
    }
  } catch {
    clearCachedChatTemplateReasoning(modelId);
    propsFetchFailedAt.delete(modelId);
  }
  const out: LlamaServerStatusPayload = {
    ok: true,
    remote: true,
    running: false,
    modelId,
    chat: { port, health: chatHealth },
  };
  if (embedBlock) {
    out.embed = embedBlock;
  }
  return attachCachedReasoning(out);
}

export async function getManagedLlamaStatus(
  modelId: string,
  config: AppConfig,
): Promise<LlamaServerStatusResult> {
  const loc = findLlmModelLocation(config.llmProviders, modelId);
  if (!loc || loc.provider.provider !== 'llamacpp') {
    return { ok: false, error: 'Not a llama.cpp model preset.' };
  }
  const m: LlmModelProfile = loc.model;
  const managed = m.llamaCppManaged;
  const st = running.get(modelId);
  if (!st) {
    invalidateManagedStatusCache(modelId);
    if (!(managed?.chatRunCommand ?? '').trim()) {
      return getRemoteLlamacppUrlStatus(
        modelId,
        loc.provider.baseUrl,
        loc.provider.embeddingsBaseUrl,
        unwrapSecret(loc.provider.apiKey),
      );
    }
    return {
      ok: true,
      running: false,
      modelId,
      chat: { port: 0, health: 'stopped' },
    };
  }
  if (!managed) {
    invalidateManagedStatusCache(modelId);
    return {
      ok: true,
      running: false,
      modelId,
      chat: { port: 0, health: 'stopped' },
    };
  }

  if (!st.chatReady || !st.chatPort) {
    return {
      ok: true,
      running: false,
      starting: true,
      modelId,
      chat: { port: st.chatPort, health: 'loading' },
    };
  }

  kickChatTemplateReasoningIfMissing(modelId, st.chatHealthHost, st.chatPort);

  const now = Date.now();
  if (
    statusCache &&
    statusCache.modelId === modelId &&
    now - statusCache.at < STATUS_CACHE_TTL_MS
  ) {
    return attachCachedReasoning(statusCache.result);
  }

  const ch = await probeOnce(st.chatHealthHost, st.chatPort);
  let emb: LlamaServerStatusPayload['embed'];
  if (st.embedPort != null && st.embedHealthHost) {
    const eh = await probeOnce(st.embedHealthHost, st.embedPort);
    emb = { port: st.embedPort, health: eh };
  }

  const out: LlamaServerStatusPayload = attachCachedReasoning({
    ok: true,
    running: st.ready,
    starting: !st.ready,
    modelId,
    chat: { port: st.chatPort, health: ch },
    embed: emb,
  });
  statusCache = { modelId, at: Date.now(), result: out };
  return out;
}

/** OpenAI-compatible ``…/v1`` base URL for the managed chat server when it is running; otherwise ``null``. */
export function getManagedChatOpenAiBaseUrl(modelId: string): string | null {
  const st = running.get(modelId);
  if (!st?.chatReady || !st.chatPort) {
    return null;
  }
  return `http://${st.chatHealthHost}:${st.chatPort}/v1`;
}

/** True if the active model preset has ready managed servers. */
export function isManagedLlamaRunningForActivePreset(config: AppConfig): boolean {
  const id = config.activeLlmModelId;
  if (!id) {
    return false;
  }
  return !!running.get(id)?.ready;
}
