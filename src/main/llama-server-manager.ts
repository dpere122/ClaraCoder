/**
 * Managed ``llama-server`` subprocesses: dynamic ports, shell commands from settings, health probes.
 */
import { spawn, type ChildProcess } from 'child_process';
import * as net from 'net';

import type {
  AppConfig,
  LlamaCppManaged,
  LlamaManagedRuntimeEndpoints,
  LlmModelProfile,
  LlamaServerStatusPayload,
  LlamaServerStatusResult,
  ManagedServerHealthState,
} from '../shared';
import { findLlmModelLocation, prepareManagedLlamaShellCommand } from '../shared';
import { mainState } from './state';
import { syncRuntimeConfigToPython } from './python/workspace-sync';

type StreamKind = 'chat' | 'embed';

interface StreamBuf {
  lastChatStdout: string;
  lastEmbedStdout: string;
  lastChatStderr: string;
  lastEmbedStderr: string;
}

const running = new Map<
  string,
  {
    chatProc: ChildProcess;
    embedProc: ChildProcess | undefined;
    chatPort: number;
    embedPort: number | undefined;
    chatHost: string;
    embedHost: string | undefined;
    logBuf: StreamBuf;
  }
>();

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
}

function killProcessTree(proc: ChildProcess | undefined): void {
  if (!proc || proc.killed || !proc.pid) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      }).on('error', () => {
        proc.kill();
      });
    } else {
      proc.kill('SIGKILL');
    }
  } catch {
    proc.kill();
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
 * Effective OpenAI-compatible URLs for each llamacpp model row (sentinel when stopped).
 */
export function getLlamaManagedRuntimeOverrides(config: AppConfig): Record<string, LlamaManagedRuntimeEndpoints> {
  const out: Record<string, LlamaManagedRuntimeEndpoints> = {};
  for (const p of config.llmProviders) {
    if (p.provider !== 'llamacpp') {
      continue;
    }
    for (const m of p.models) {
      const st = running.get(m.id);
      if (st) {
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
  await syncRuntimeConfigToPython(config, getLlamaManagedRuntimeOverrides(config));
}

function appendStdout(bucket: StreamBuf, which: StreamKind, chunk: string): void {
  if (!chunk) {
    return;
  }
  const sink = which === 'chat' ? 'lastChatStdout' : 'lastEmbedStdout';
  bucket[sink] = (bucket[sink] + chunk).slice(-2500);
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
): void {
  proc.stdout?.on('data', (d: Buffer) => {
    const s = d.toString();
    appendStdout(bucket, which, s);
    sendToRenderer('llama-server-output', { modelId, stream: which, fd: 'stdout', data: s });
  });
  proc.stderr?.on('data', (d: Buffer) => {
    const s = d.toString();
    appendStderrQuiet(bucket, which, s);
    sendToRenderer('llama-server-output', { modelId, stream: which, fd: 'stderr', data: s });
  });
  proc.on('exit', (code, signal) => {
    sendToRenderer('llama-server-process-exit', {
      modelId,
      stream: which,
      code,
      signal: signal != null ? String(signal) : null,
    });
  });
}

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

  const chatCmd = (managed.chatRunCommand || '').trim();
  if (!chatCmd) {
    return { ok: false, error: 'chatRunCommand is empty.' };
  }

  const chatPort = await pickPort();
  let embedPort: number | undefined;
  const embedCmd = (managed.embeddingRunCommand || '').trim();
  if (embedCmd) {
    embedPort = await pickPort();
    if (embedPort === chatPort) {
      return { ok: false, error: 'Could not allocate two distinct ports.' };
    }
  }

  const chatBuilt = prepareManagedLlamaShellCommand(chatCmd, chatPort);
  if (!chatBuilt.ok) {
    return { ok: false, error: chatBuilt.error };
  }

  let embedBuilt: { command: string; host: string } | undefined;
  if (embedCmd && embedPort != null) {
    const eb = prepareManagedLlamaShellCommand(embedCmd, embedPort);
    if (!eb.ok) {
      return { ok: false, error: eb.error };
    }
    embedBuilt = { command: eb.command, host: eb.host };
  }

  sendToRenderer('llama-server-lifecycle', { phase: 'starting', modelId });

  const logBuf: StreamBuf = { lastChatStdout: '', lastEmbedStdout: '', lastChatStderr: '', lastEmbedStderr: '' };
  let embedProc: ChildProcess | undefined;

  try {
    if (embedBuilt && embedPort != null) {
      embedProc = spawn(embedBuilt.command, {
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env },
      });
      attachLlamaStreams(modelId, 'embed', embedProc, logBuf);
      embedProc.on('error', () => {
        /* spawn errors surface via exit / health wait */
      });
    }

    const chatProc = spawn(chatBuilt.command, {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env },
    });
    attachLlamaStreams(modelId, 'chat', chatProc, logBuf);
    chatProc.on('error', () => {
      /* spawn errors surface via exit / health wait */
    });

    running.set(modelId, {
      chatProc,
      embedProc,
      chatPort,
      embedPort,
      chatHost: chatBuilt.host,
      embedHost: embedBuilt?.host,
      logBuf,
    });

    const chatHost = chatBuilt.host;
    const chatWait = await waitForHealth(chatHost, chatPort, 120_000, chatProc);
    if (chatWait !== 'ok') {
      stopManagedLlamaServers(modelId);
      if (chatWait === 'exited') {
        return {
          ok: false,
          error: shortEarlyExitError('Chat', chatProc),
        };
      }
      return {
        ok: false,
        error: `Chat llama-server did not become healthy in time (no HTTP 200 from http://${chatHost}:${chatPort}/health). See the llama.cpp server terminal tab for output.`,
      };
    }

    if (embedProc && embedPort != null && embedBuilt) {
      const embHost = embedBuilt.host;
      const embWait = await waitForHealth(embHost, embedPort, 120_000, embedProc);
      if (embWait !== 'ok') {
        stopManagedLlamaServers(modelId);
        if (embWait === 'exited') {
          return {
            ok: false,
            error: shortEarlyExitError('Embedding', embedProc),
          };
        }
        return {
          ok: false,
          error: 'Embedding llama-server did not become healthy in time. See the llama.cpp server terminal tab for output.',
        };
      }
    }

    await syncWithManagedLlamaOverrides(config);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    stopManagedLlamaServers(modelId);
    return { ok: false, error: msg };
  }
}

function shortEarlyExitError(label: string, proc: ChildProcess): string {
  const code = proc.exitCode;
  const sig = proc.signalCode;
  const why =
    code !== null ? `exit ${code}` : sig != null ? `signal ${sig}` : 'exited unexpectedly';
  return `${label} llama-server process ended (${why}). See the llama.cpp server terminal tab for stdout; stderr is not mirrored to app logs.`;
}

function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return fetch(url, { signal: ac.signal }).finally(() => clearTimeout(t));
}

function childHasExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

type HealthWait = 'ok' | 'timeout' | 'exited';

async function waitForHealth(
  host: string,
  port: number,
  timeoutMs: number,
  proc?: ChildProcess,
): Promise<HealthWait> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc && childHasExited(proc)) {
      return 'exited';
    }
    try {
      const res = await fetchWithTimeout(`http://${host}:${port}/health`, 2000);
      if (res.ok) {
        return 'ok';
      }
    } catch {
      /* still loading */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return 'timeout';
}

export function stopManagedLlamaServers(modelId: string): void {
  const st = running.get(modelId);
  if (!st) {
    return;
  }
  invalidateManagedStatusCache(modelId);
  sendToRenderer('llama-server-lifecycle', { phase: 'stopped', modelId });
  killProcessTree(st.embedProc);
  killProcessTree(st.chatProc);
  running.delete(modelId);
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
  if (!st || !managed) {
    invalidateManagedStatusCache(modelId);
    return {
      ok: true,
      running: false,
      modelId,
      chat: { port: 0, health: 'stopped' },
    };
  }

  const now = Date.now();
  if (
    statusCache &&
    statusCache.modelId === modelId &&
    now - statusCache.at < STATUS_CACHE_TTL_MS
  ) {
    return statusCache.result;
  }

  const chatHost = st.chatHost;
  const ch = await probeOnce(chatHost, st.chatPort);
  let emb: LlamaServerStatusPayload['embed'];
  if (st.embedPort != null && st.embedHost) {
    const eh = await probeOnce(st.embedHost, st.embedPort);
    emb = { port: st.embedPort, health: eh };
  }

  const out: LlamaServerStatusPayload = {
    ok: true,
    running: true,
    modelId,
    chat: { port: st.chatPort, health: ch },
    embed: emb,
  };
  statusCache = { modelId, at: Date.now(), result: out };
  return out;
}

/** True if the active model preset has running managed servers. */
export function isManagedLlamaRunningForActivePreset(config: AppConfig): boolean {
  const id = config.activeLlmModelId;
  return !!id && running.has(id);
}
