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
import { findLlmModelLocation, looksLikeLlamaModelDownload, managedLlamaCmdUsesHfRemoteModel, prepareManagedLlamaShellCommand } from '../shared';
import { openAiV1BaseToServerRoot } from './openai-compatible-models';
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
      /**
       * Managed servers are spawned with ``detached: true`` on POSIX so this PID is a new session /
       * process-group leader (the shell). Killing the group tears down ``llama-server`` too.
       * Without that, ``SIGKILL`` on the shell alone often orphans the real server on Linux.
       */
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        proc.kill('SIGKILL');
      }
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
 * Effective OpenAI-compatible URLs for each **managed** llamacpp model (spawned subprocess).
 * Skips URL-only rows (no ``chatRunCommand``) so Python uses the persisted provider ``baseUrl``.
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

function logTailForStream(bucket: StreamBuf, which: StreamKind): string {
  const out = which === 'chat' ? bucket.lastChatStdout : bucket.lastEmbedStdout;
  const err = which === 'chat' ? bucket.lastChatStderr : bucket.lastEmbedStderr;
  return `${out}\n${err}`.slice(-12_000);
}

function buildManagedLlamaSpawnEnv(config: AppConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const tok = config.modelManager.huggingFaceToken.trim();
  if (tok) {
    env.HF_TOKEN = tok;
    env.HUGGING_FACE_HUB_TOKEN = tok;
  }
  return env;
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
  const spawnEnv = buildManagedLlamaSpawnEnv(config);

  try {
    /**
     * Start chat first and wait for ``/health`` before spawning embedding.
     * If chat fails (e.g. wrong ``-hf`` / 404), we must not have started embed yet—otherwise
     * ``stopManagedLlamaServers`` would kill a long embed download that was never going to be used.
     */
    const chatProc = spawn(chatBuilt.command, {
      shell: true,
      /** POSIX: new process group so ``kill(-pid)`` stops ``llama-server``, not just ``sh``. */
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: spawnEnv,
    });
    attachLlamaStreams(modelId, 'chat', chatProc, logBuf);
    chatProc.on('error', () => {
      /* spawn errors surface via exit / health wait */
    });

    const chatHost = chatBuilt.host;
    const chatBudgetMs = managedLlamaCmdUsesHfRemoteModel(chatCmd) ? HEALTH_WAIT_HF_CMD_MS : HEALTH_WAIT_DEFAULT_MS;
    const chatWait = await waitForHealth(chatHost, chatPort, chatBudgetMs, {
      proc: chatProc,
      getLogTail: () => logTailForStream(logBuf, 'chat'),
      modelId,
    });
    if (chatWait !== 'ok') {
      killProcessTree(chatProc);
      if (chatWait === 'exited') {
        return {
          ok: false,
          error: shortEarlyExitError('Chat', chatProc, logBuf, 'chat'),
        };
      }
      return {
        ok: false,
        error: `Chat llama-server did not become healthy in time (no HTTP 200 from http://${chatHost}:${chatPort}/health). See the llama.cpp server terminal tab for output.`,
      };
    }

    running.set(modelId, {
      chatProc,
      embedProc: undefined,
      chatPort,
      embedPort: undefined,
      chatHost: chatBuilt.host,
      embedHost: undefined,
      logBuf,
    });
    invalidateManagedStatusCache(modelId);
    await syncWithManagedLlamaOverrides(config);

    if (embedBuilt && embedPort != null) {
      embedProc = spawn(embedBuilt.command, {
        shell: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: spawnEnv,
      });
      attachLlamaStreams(modelId, 'embed', embedProc, logBuf);
      embedProc.on('error', () => {
        /* spawn errors surface via exit / health wait */
      });

      const st = running.get(modelId);
      if (st) {
        st.embedProc = embedProc;
        st.embedPort = embedPort;
        st.embedHost = embedBuilt.host;
      }
      invalidateManagedStatusCache(modelId);

      const embHost = embedBuilt.host;
      const embedBudgetMs = managedLlamaCmdUsesHfRemoteModel(embedCmd) ? HEALTH_WAIT_HF_CMD_MS : HEALTH_WAIT_DEFAULT_MS;
      const embWait = await waitForHealth(embHost, embedPort, embedBudgetMs, {
        proc: embedProc,
        getLogTail: () => logTailForStream(logBuf, 'embed'),
        modelId,
      });
      if (embWait !== 'ok') {
        stopManagedLlamaServers(modelId);
        if (embWait === 'exited') {
          return {
            ok: false,
            error: shortEarlyExitError('Embedding', embedProc, logBuf, 'embed'),
          };
        }
        return {
          ok: false,
          error: 'Embedding llama-server did not become healthy in time. See the llama.cpp server terminal tab for output.',
        };
      }
    }

    await syncWithManagedLlamaOverrides(config);
    sendToRenderer('llama-server-lifecycle', { phase: 'running', modelId });
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    stopManagedLlamaServers(modelId);
    return { ok: false, error: msg };
  }
}

function shortEarlyExitError(label: string, proc: ChildProcess, logBuf: StreamBuf, kind: StreamKind): string {
  const code = proc.exitCode;
  const sig = proc.signalCode;
  const why =
    code !== null ? `exit ${code}` : sig != null ? `signal ${sig}` : 'exited unexpectedly';
  return `${label} llama-server process ended (${why}). See the llama.cpp server terminal tab for stdout; stderr is not mirrored to app logs.${hfWarmHintFromLogs(logBuf, kind)}`;
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

interface HealthWaitContext {
  proc?: ChildProcess;
  /** Recent stdout+stderr for this stream (used to detect long HF / model downloads). */
  getLogTail?: () => string;
  modelId?: string;
}

const HEALTH_POLL_MS = 500;
/** Default wait when the command does not look like a remote HF pull. */
const HEALTH_WAIT_DEFAULT_MS = 120_000;
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
    if (ctx?.proc && childHasExited(ctx.proc)) {
      return 'exited';
    }
    try {
      const res = await fetchWithTimeout(`http://${host}:${port}/health`, 2000);
      if (res.ok) {
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

  const probeHttpHealth = async (baseRoot: string): Promise<ManagedServerHealthState> => {
    try {
      const res = await fetchWithTimeout(`${baseRoot}/health`, 2000);
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
  return out;
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
      return getRemoteLlamacppUrlStatus(modelId, loc.provider.baseUrl, loc.provider.embeddingsBaseUrl);
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

/** OpenAI-compatible ``…/v1`` base URL for the managed chat server when it is running; otherwise ``null``. */
export function getManagedChatOpenAiBaseUrl(modelId: string): string | null {
  const st = running.get(modelId);
  if (!st) {
    return null;
  }
  return `http://${st.chatHost}:${st.chatPort}/v1`;
}

/** True if the active model preset has running managed servers. */
export function isManagedLlamaRunningForActivePreset(config: AppConfig): boolean {
  const id = config.activeLlmModelId;
  return !!id && running.has(id);
}
