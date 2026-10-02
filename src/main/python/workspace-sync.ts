import type {
  AppConfig,
  ChatTemplateReasoningCaps,
  LlamaManagedRuntimeEndpoints,
  LlmConnectionConfig,
  WorkspaceContextSyncExtras,
} from '../../shared';
import {
  effectiveLmStudioContextTokens,
  flattenLlmProvidersToConnections,
  lmStudioOpenAiBaseUrlToRestOrigin,
} from '../../shared';
import { unwrapSecret } from '../../shared/types/app-config';
import { ensurePythonReady } from './server';
import { pythonControlFetch } from './http-client';
import { getHostOsInfo } from '../utils/host-os';
import { readWorkspaceSystemPromptText } from '../workspace/system-prompt';
import {
  getAllCachedChatTemplateReasoning,
  getAllCachedLlamaServerNctx,
  setCachedLlamaServerNctx,
} from '../chat-template-reasoning-cache';
import { lmStudioListModels } from '../lm-studio-client';
import { refreshOpenRouterReasoningCaps } from '../openrouter-reasoning';

function hasUrlScheme(s: string): boolean {
  return /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(s);
}

function loopbackHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

/**
 * ``0.0.0.0`` / ``::`` are server bind addresses; HTTP clients must use a concrete host (loopback for same machine).
 */
export function normalizeBindAllHostToLocalhost(url: string): string {
  const s = url.trim();
  if (!s) {
    return s;
  }
  try {
    const raw = hasUrlScheme(s) ? s : `http://${s}`;
    const u = new URL(raw);
    const h = u.hostname.toLowerCase();
    if (h !== '0.0.0.0' && h !== '::') {
      return s;
    }
    u.hostname = '127.0.0.1';
    return u.href;
  } catch {
    return s;
  }
}

/**
 * If chat targets a non-loopback host but the embeddings base URL still uses loopback,
 * reuse the chat hostname so LAN setups do not keep the default ``127.0.0.1:8081`` row after
 * updating chat to ``http://192.168.x.x:8080/v1`` only.
 */
export function alignLlamaEmbeddingsBaseUrlWithChatHost(chatBaseUrl: string, embeddingsBaseUrl: string): string {
  const chat = chatBaseUrl.trim();
  const emb = embeddingsBaseUrl.trim();
  if (!chat || !emb) {
    return emb;
  }
  try {
    const chatRaw = hasUrlScheme(chat) ? chat : `http://${chat}`;
    const embRaw = hasUrlScheme(emb) ? emb : `http://${emb}`;
    const chatUrl = new URL(chatRaw);
    const embUrl = new URL(embRaw);
    if (!loopbackHost(embUrl.hostname)) {
      return emb;
    }
    if (loopbackHost(chatUrl.hostname)) {
      return emb;
    }
    embUrl.hostname = chatUrl.hostname;
    let path = embUrl.pathname.replace(/\/+$/, '') || '';
    if (!path.endsWith('/v1')) {
      path = `${path}/v1`.replace(/\/+/g, '/');
      if (!path.startsWith('/')) {
        path = `/${path}`;
      }
    }
    return `${embUrl.origin}${path}`;
  } catch {
    return emb;
  }
}

/** Ensure an OpenAI-compatible chat/embeddings base ends with ``/v1``. */
export function ensureOpenAiV1Base(url: string): string {
  const s = (url || '').trim().replace(/\/+$/, '');
  if (!s) {
    return s;
  }
  if (s.toLowerCase().endsWith('/v1')) {
    return s;
  }
  return `${s}/v1`;
}

/** Compare OpenAI-compatible ``…/v1`` bases for equality (trailing slashes optional). */
export function openAiV1BasesEquivalent(a: string, b: string): boolean {
  return ensureOpenAiV1Base(a).toLowerCase() === ensureOpenAiV1Base(b).toLowerCase();
}

/**
 * In-process CPU FastEmbed is the primary embedding backend. HTTP embeddings are no longer used,
 * so this always returns false. Kept for wire compatibility.
 */
export function embeddingsEnabledForWire(
  _c: LlmConnectionConfig,
  _llamaOverride: LlamaManagedRuntimeEndpoints | undefined,
): boolean {
  return false;
}

/**
 * In-process CPU FastEmbed is the primary embedding backend. No HTTP embeddings are configured,
 * so this always returns false. Kept for wire compatibility.
 */
export function embeddingsConfiguredForWire(_c: LlmConnectionConfig): boolean {
  return false;
}

function chatTemplateReasoningWire(
  caps: ChatTemplateReasoningCaps | undefined,
): Record<string, unknown> | undefined {
  if (!caps) {
    return undefined;
  }
  return {
    enableThinking: caps.enableThinking,
    reasoningEffortValues: caps.reasoningEffortValues == null ? null : [...caps.reasoningEffortValues],
  };
}

/** One row for ``POST /runtime-config`` (camelCase keys match Pydantic). */
function connectionToRuntimeWire(
  c: LlmConnectionConfig,
  llamaOverride: LlamaManagedRuntimeEndpoints | undefined,
  reasoningCaps: ChatTemplateReasoningCaps | undefined,
  liveNctx: number | undefined,
): Record<string, unknown> {
  const resolvedBase = c.provider === 'llamacpp' && llamaOverride ? llamaOverride.baseUrl : c.baseUrl;
  const normalizedHost = normalizeBindAllHostToLocalhost(resolvedBase);
  const baseUrl =
    c.provider === 'lmstudio' || c.provider === 'llamacpp' || c.provider === 'openrouter'
      ? ensureOpenAiV1Base(normalizedHost)
      : normalizedHost;
  const rawEmbeddingsBase =
    c.provider === 'llamacpp' && llamaOverride
      ? (llamaOverride.embeddingsBaseUrl || '').trim() || (c.embeddingsBaseUrl ?? '').trim()
      : (c.embeddingsBaseUrl ?? '').trim();
  const alignedEmb =
    c.provider === 'llamacpp'
      ? alignLlamaEmbeddingsBaseUrlWithChatHost(baseUrl, rawEmbeddingsBase)
      : rawEmbeddingsBase;
  const embeddingsHost = normalizeBindAllHostToLocalhost(alignedEmb);
  const embeddingsBaseUrl =
    c.provider === 'lmstudio' || c.provider === 'llamacpp' ? ensureOpenAiV1Base(embeddingsHost) : embeddingsHost;
  const chatTemplateReasoning = chatTemplateReasoningWire(reasoningCaps);
  const contextWindowTokens =
    typeof liveNctx === 'number' && Number.isFinite(liveNctx) && liveNctx > 0
      ? Math.floor(liveNctx)
      : c.contextWindowTokens;
  return {
    id: c.id,
    name: c.name,
    provider: c.provider,
    baseUrl,
    model: c.model,
    apiKey: c.apiKey,
    reasoningEffort: c.reasoningEffort ?? '',
    temperature: c.temperature,
    parallelToolCalls: c.parallelToolCalls,
    optimizationPreset: c.optimizationPreset,
    maxOutputTokens: c.maxOutputTokens,
    thinkingMode: c.thinkingMode,
    samplingPreset: c.samplingPreset,
    topP: c.topP ?? null,
    topK: c.topK ?? null,
    minP: c.minP ?? null,
    presencePenalty: c.presencePenalty ?? null,
    repeatPenalty: c.repeatPenalty ?? null,
    architectureHint: c.architectureHint,
    embeddingsBaseUrl,
    embeddingsModel: (c.embeddingsModel ?? '').trim(),
    embeddingsEnabled: embeddingsEnabledForWire(c, llamaOverride),
    embeddingsConfigured: embeddingsConfiguredForWire(c),
    contextWindowTokens,
    ...(chatTemplateReasoning ? { chatTemplateReasoning } : {}),
  };
}

/**
 * POST active LLM + audio config and host OS to Python so chat/transcribe use current settings.
 * @param llamaManagedEndpoints per model preset id for ``llamacpp`` (managed dynamic ports),
 *   or a getter evaluated at send time so the last sync reflects live process state.
 *
 * Calls are serialized: a newer sync (e.g. start) always lands after an older one (e.g. save),
 * and overrides are read live, so the last writer wins with current ``running`` state instead of
 * a snapshot captured when the older call was initiated (which could clobber real ports with
 * ``127.0.0.1:0`` if its POST was delayed).
 */
let runtimeSyncChain: Promise<void> = Promise.resolve();

export async function syncRuntimeConfigToPython(
  config: AppConfig,
  llamaManagedEndpoints?:
    | Record<string, LlamaManagedRuntimeEndpoints>
    | (() => Record<string, LlamaManagedRuntimeEndpoints> | undefined),
): Promise<void> {
  const send = async (): Promise<void> => {
    const overrides =
      typeof llamaManagedEndpoints === 'function' ? llamaManagedEndpoints() : llamaManagedEndpoints;
    const modelsDir = config.modelManager?.customModelsDir?.trim();
    if (modelsDir) {
      process.env.CLARA_CUSTOM_MODELS_DIR = modelsDir;
    } else {
      delete process.env.CLARA_CUSTOM_MODELS_DIR;
    }
    await postRuntimeConfigToPython(config, overrides);
  };
  runtimeSyncChain = runtimeSyncChain
    .then(send)
    .catch((err) => {
      console.error('Failed to sync runtime config to Python:', err);
    })
    .then(() => undefined);
  await runtimeSyncChain;
}

async function refreshLmStudioLiveNctx(config: AppConfig): Promise<void> {
  const groups = new Map<string, { apiKey: string; rows: Array<{ id: string; model: string }> }>();
  for (const p of config.llmProviders) {
    if (p.provider !== 'lmstudio') {
      continue;
    }
    const origin = lmStudioOpenAiBaseUrlToRestOrigin(p.baseUrl) || p.baseUrl.trim();
    if (!origin) {
      continue;
    }
    let g = groups.get(origin);
    if (!g) {
      g = { apiKey: unwrapSecret(p.apiKey), rows: [] };
      groups.set(origin, g);
    }
    for (const m of p.models) {
      const model = (m.model || '').trim();
      if (model) {
        g.rows.push({ id: m.id, model });
      }
    }
  }
  await Promise.all(
    [...groups.entries()].map(async ([origin, g]) => {
      try {
        const res = await lmStudioListModels(origin, g.apiKey);
        if (!res.ok) {
          return;
        }
        const byId = new Map(res.models.map((card) => [card.id, card]));
        for (const row of g.rows) {
          const card = byId.get(row.model);
          const n = card ? effectiveLmStudioContextTokens(card) : 0;
          if (n > 0) {
            setCachedLlamaServerNctx(row.id, n);
          }
        }
      } catch {
        /* LM Studio unreachable — keep persisted contextWindowTokens */
      }
    }),
  );
}

async function postRuntimeConfigToPython(
  config: AppConfig,
  llamaManagedEndpoints?: Record<string, LlamaManagedRuntimeEndpoints>,
): Promise<void> {
  try {
    await Promise.all([refreshLmStudioLiveNctx(config), refreshOpenRouterReasoningCaps(config)]);
    const flat = flattenLlmProvidersToConnections(config.llmProviders);
    const reasoningById = getAllCachedChatTemplateReasoning();
    const nCtxById = getAllCachedLlamaServerNctx();
    const connections = flat.map((c) =>
      connectionToRuntimeWire(
        c,
        c.provider === 'llamacpp' ? llamaManagedEndpoints?.[c.id] : undefined,
        reasoningById[c.id],
        nCtxById[c.id],
      ),
    );
    const response = await pythonControlFetch('/runtime-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activeConnectionId: config.activeLlmModelId,
        connections,
        audio: {
          ...config.audioTranscription,
          customModelsDir: config.modelManager?.customModelsDir?.trim() ?? '',
        },
        host: getHostOsInfo(),
        tools: {
          editToolsStrict: config.workspaceTools.editToolsMode === 'strict',
          maxFileReadLines: config.workspaceTools.maxFileReadLines,
          maxSearchResults: config.workspaceTools.maxSearchResults,
          defaultWorkspaceEncoding: config.workspaceTools.defaultWorkspaceEncoding,
          defaultWorkspaceNewline: config.workspaceTools.defaultWorkspaceNewline,
          allowStagingOverlayCommands: config.workspaceTools.allowStagingOverlayCommands ?? false,
          commandLineExplainStep: config.workspaceTools.commandLineExplainStep ?? false,
          exposeAllWorkspaceFiles: config.workspaceTools.exposeAllWorkspaceFiles ?? false,
          allowWebAccess: config.workspaceTools.allowWebAccess ?? false,
          searxngBaseUrl: (config.workspaceTools.searxngBaseUrl ?? '').trim(),
          extraUserPath: config.workspaceTools.extraUserPath ?? '',
          enableAgentFormatters: config.workspaceTools.enableAgentFormatters ?? false,
        },
        contextCompression: {
          enabled: config.contextCompression.enabled,
          triggerRatio: config.contextCompression.triggerRatio,
          targetRatio: config.contextCompression.targetRatio,
          protectTailMessages: config.contextCompression.protectTailMessages,
          recentToolBodyMaxChars: config.contextCompression.recentToolBodyMaxChars,
          oldToolBodyMaxChars: config.contextCompression.oldToolBodyMaxChars,
          systemReserveRatio: config.contextCompression.systemReserveRatio,
        },
        huggingFaceToken: unwrapSecret(config.modelManager?.huggingFaceToken ?? ''),
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Runtime config sync failed (${response.status}): ${detail}`);
    }
  } catch (err) {
    console.error('Failed to sync runtime config to Python:', err);
  }
}

/**
 * Pushes workspace tree text into the Python agent context.
 */
export async function syncWorkspaceContextToPython(
  sessionId: string,
  workspacePath: string,
  workspaceContext: string,
  extras?: WorkspaceContextSyncExtras,
): Promise<void> {
  const body: Record<string, unknown> = {
    session_id: sessionId,
    workspace_path: workspacePath,
    workspace_context: workspaceContext,
  };
  if (extras?.workspaceId !== undefined) {
    body.workspace_id = extras.workspaceId ?? '';
  }
  if (extras?.workspaceFileChanges?.paths?.length) {
    body.workspace_file_changes = {
      paths: extras.workspaceFileChanges.paths,
      kinds: extras.workspaceFileChanges.kinds ?? [],
    };
  }
  const pyInterp = (extras?.pythonInterpreterId ?? '').trim();
  if (pyInterp) {
    body.python_interpreter_id = pyInterp;
  }
  if (extras?.bootstrapPythonEnv) {
    body.bootstrap_python_env = true;
  }
  if (extras?.skipEnvBootstrap) {
    body.skip_env_bootstrap = true;
  }
  const workspaceRoot = (workspacePath || '').trim();
  body.workspace_system_prompt = workspaceRoot
    ? await readWorkspaceSystemPromptText(workspaceRoot)
    : '';
  // Window opens before the sidecar finishes booting; wait instead of failing the IPC.
  await ensurePythonReady();
  const res = await pythonControlFetch('/workspace-context', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `workspace-context failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    );
  }
}

/**
 * Push only the workspace `.clara/system-prompt.md` text into a Python session.
 * Used after Monaco save so injection does not depend on the file watcher tree.
 */
export async function syncWorkspaceSystemPromptToPython(
  sessionId: string,
  workspaceRoot: string,
): Promise<void> {
  const sid = (sessionId || '').trim();
  if (!sid) {
    return;
  }
  const text = await readWorkspaceSystemPromptText(workspaceRoot);
  await ensurePythonReady();
  const res = await pythonControlFetch('/workspace-system-prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: sid,
      workspace_system_prompt: text,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `workspace-system-prompt failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    );
  }
}

/** Discovered interpreters for the session workspace (LSP analysis env). */
export async function fetchPythonInterpretersFromPython(sessionId: string): Promise<{
  interpreters: Array<{
    id: string;
    label: string;
    pythonExecutable: string;
    venvPath: string;
  }>;
  activeInterpreterId: string | null;
}> {
  const qs = new URLSearchParams({ session_id: sessionId });
  const response = await pythonControlFetch(`/session/python-interpreters?${qs}`);
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Python interpreters list failed (${response.status}): ${detail}`);
  }
  return response.json() as Promise<{
    interpreters: Array<{
      id: string;
      label: string;
      pythonExecutable: string;
      venvPath: string;
    }>;
    activeInterpreterId: string | null;
  }>;
}

/** Apply interpreter selection and restart the Python LSP server subprocess for this session. */
export async function postPythonInterpreterSelection(sessionId: string, interpreterId: string): Promise<void> {
  const response = await pythonControlFetch('/session/python-interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: sessionId,
      interpreter_id: interpreterId,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Python interpreter apply failed (${response.status}): ${detail}`);
  }
}
