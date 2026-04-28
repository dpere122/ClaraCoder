import type {
  AppConfig,
  LlamaManagedRuntimeEndpoints,
  LlmConnectionConfig,
  WorkspaceContextSyncExtras,
} from '../../shared';
import { flattenLlmProvidersToConnections } from '../../shared';
import { PYTHON_URL } from './server';
import { getHostOsInfo } from '../utils/host-os';

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
  if (!(c.llamaCppManaged?.embeddingRunCommand ?? '').trim()) {
    return false;
  }
  const managedEmb = (llamaOverride?.embeddingsBaseUrl ?? '').trim();
  const staticEmb = (c.embeddingsBaseUrl ?? '').trim();
  return !!(managedEmb || staticEmb);
}

/** One row for ``POST /runtime-config`` (camelCase keys match Pydantic). */
function connectionToRuntimeWire(
  c: LlmConnectionConfig,
  llamaOverride: LlamaManagedRuntimeEndpoints | undefined,
): Record<string, unknown> {
  const baseUrl = c.provider === 'llamacpp' && llamaOverride ? llamaOverride.baseUrl : c.baseUrl;
  const embeddingsBaseUrl =
    c.provider === 'llamacpp' && llamaOverride
      ? (llamaOverride.embeddingsBaseUrl || '').trim() || (c.embeddingsBaseUrl ?? '').trim()
      : (c.embeddingsBaseUrl ?? '').trim();
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
    embeddingsEnabled: embeddingsEnabledForWire(c, llamaOverride),
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
          orchestratedMode: config.workspaceTools.orchestratedMode ?? false,
          outerPhasedCodingCycle: config.workspaceTools.outerPhasedCodingCycle ?? false,
          allowStagingOverlayCommands: config.workspaceTools.allowStagingOverlayCommands ?? false,
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
  await fetch(`${PYTHON_URL}/workspace-context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
