import type {
  AppConfig,
  LlamaManagedRuntimeEndpoints,
  LlmConnectionConfig,
  WorkspaceContextSyncExtras,
} from '../../shared';
import { flattenLlmProvidersToConnections } from '../../shared';
import { PYTHON_URL } from './server';
import { getHostOsInfo } from '../utils/host-os';

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

/**
 * When false, Python skips workspace embeddings / semantic index for this connection.
 * llama.cpp: true only when the preset has a non-empty ``embeddingRunCommand`` and a reachable embeddings base URL is known
 * (managed embedding server running, or a static per-preset ``embeddingsBaseUrl``). OpenAI/LM Studio: always true.
 */
function embeddingsEnabledForWire(
  c: LlmConnectionConfig,
  llamaOverride: LlamaManagedRuntimeEndpoints | undefined,
): boolean {
  if (c.provider !== 'llamacpp') {
    return true;
  }
  const managedEmb = (llamaOverride?.embeddingsBaseUrl ?? '').trim();
  const staticEmb = (c.embeddingsBaseUrl ?? '').trim();
  if ((c.llamaCppManaged?.embeddingRunCommand ?? '').trim()) {
    return !!(managedEmb || staticEmb);
  }
  // URL-only / static llama-server: no managed embedding process; enable when a chat or embeddings base URL is set.
  return !!(c.baseUrl ?? '').trim() || !!staticEmb;
}

/** One row for ``POST /runtime-config`` (camelCase keys match Pydantic). */
function connectionToRuntimeWire(
  c: LlmConnectionConfig,
  llamaOverride: LlamaManagedRuntimeEndpoints | undefined,
): Record<string, unknown> {
  const resolvedBase = c.provider === 'llamacpp' && llamaOverride ? llamaOverride.baseUrl : c.baseUrl;
  const baseUrl = normalizeBindAllHostToLocalhost(resolvedBase);
  const rawEmbeddingsBase =
    c.provider === 'llamacpp' && llamaOverride
      ? (llamaOverride.embeddingsBaseUrl || '').trim() || (c.embeddingsBaseUrl ?? '').trim()
      : (c.embeddingsBaseUrl ?? '').trim();
  const alignedEmb =
    c.provider === 'llamacpp'
      ? alignLlamaEmbeddingsBaseUrlWithChatHost(baseUrl, rawEmbeddingsBase)
      : rawEmbeddingsBase;
  const embeddingsBaseUrl = normalizeBindAllHostToLocalhost(alignedEmb);
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
    planRetryAttemptsCount: c.planRetryAttemptsCount,
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
    contextWindowTokens: c.contextWindowTokens,
  };
}

/**
 * POST active LLM + audio config and host OS to Python so chat/transcribe use current settings.
 * @param llamaManagedEndpoints per model preset id for ``llamacpp`` (managed dynamic ports).
 */
export async function syncRuntimeConfigToPython(
  config: AppConfig,
  llamaManagedEndpoints?: Record<string, LlamaManagedRuntimeEndpoints>,
): Promise<void> {
  try {
    const flat = flattenLlmProvidersToConnections(config.llmProviders);
    const connections = flat.map((c) =>
      connectionToRuntimeWire(c, c.provider === 'llamacpp' ? llamaManagedEndpoints?.[c.id] : undefined),
    );
    const response = await fetch(`${PYTHON_URL}/runtime-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activeConnectionId: config.activeLlmModelId,
        connections,
        audio: config.audioTranscription,
        host: getHostOsInfo(),
        tools: {
          editToolsStrict: config.workspaceTools.editToolsMode === 'strict',
          maxFileReadLines: config.workspaceTools.maxFileReadLines,
          maxSearchResults: config.workspaceTools.maxSearchResults,
          defaultWorkspaceEncoding: config.workspaceTools.defaultWorkspaceEncoding,
          defaultWorkspaceNewline: config.workspaceTools.defaultWorkspaceNewline,
          allowStagingOverlayCommands: config.workspaceTools.allowStagingOverlayCommands ?? false,
          exposeAllWorkspaceFiles: config.workspaceTools.exposeAllWorkspaceFiles ?? false,
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
  await fetch(`${PYTHON_URL}/workspace-context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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
  const u = new URL(`${PYTHON_URL}/session/python-interpreters`);
  u.searchParams.set('session_id', sessionId);
  const response = await fetch(u.toString());
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
  const response = await fetch(`${PYTHON_URL}/session/python-interpreter`, {
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
