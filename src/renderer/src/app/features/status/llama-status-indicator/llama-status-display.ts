import type { LlamaServerStatusResult, ManagedServerHealthState } from '@shared/index';

/** Traffic-light state for a single managed server dot (model / embeddings). */
export type LlamaStatusDotState = 'green' | 'yellow' | 'gray' | 'red';

const STABLE_OK_MS = 15_000;
const UNSTABLE_MS = 2_500;

/**
 * Poll interval: slow while chat (+ embed if any) are ok and running; faster when warming, failing, or stopped.
 */
export function computeStatusPollIntervalMs(status: LlamaServerStatusResult | null): number {
  if (!status || status.ok === false) {
    return UNSTABLE_MS;
  }
  const live = status.running || (status.ok === true && status.remote === true);
  if (!live) {
    return UNSTABLE_MS;
  }
  const parts: ManagedServerHealthState[] = [status.chat.health];
  if (status.embed) {
    parts.push(status.embed.health);
  }
  if (parts.every((h) => h === 'ok')) {
    return STABLE_OK_MS;
  }
  return UNSTABLE_MS;
}

/** Map a probed health state (or ``'off'`` when not running / not configured) to a traffic-light dot. */
export function healthDotState(health: ManagedServerHealthState | 'off'): LlamaStatusDotState {
  switch (health) {
    case 'ok':
      return 'green';
    case 'loading':
      return 'yellow';
    case 'error':
      return 'red';
    default:
      // 'stopped' | 'off'
      return 'gray';
  }
}

/**
 * Model-dot color for managed llama.cpp: yellow while the server is starting or
 * fetching weights, even before ``/health`` succeeds and ``running`` is true.
 */
export function modelStatusDotState(
  warming: 'starting' | 'downloading' | null,
  status: LlamaServerStatusResult | null,
): LlamaStatusDotState {
  if (warming === 'starting' || warming === 'downloading') {
    return 'yellow';
  }
  if (!status || status.ok === false) {
    return 'gray';
  }
  if (status.starting) {
    return 'yellow';
  }
  const live = status.running || status.remote === true;
  if (!live) {
    return 'gray';
  }
  return healthDotState(status.chat.health);
}

/** OpenRouter has no local server probe. Green once a model id and API key are set. */
export function openRouterModelDotState(model: string, apiKey: string): LlamaStatusDotState {
  return model.trim() && apiKey.trim() ? 'green' : 'gray';
}

/** Map a CPU embeddings load status (from Python ``GET /embeddings/status``) to a dot. */
export function embeddingsStatusDotState(status: string): LlamaStatusDotState {
  switch (status) {
    case 'ready':
      return 'green';
    case 'loading':
      return 'yellow';
    case 'error':
      return 'red';
    default:
      // 'idle' | 'disabled'
      return 'gray';
  }
}

/**
 * One-line model status for the home Runtime panel: managed llama.cpp shows its server state
 * (Running / Starting… / Stopped), OpenRouter and remote llama URLs show whether they are connected.
 * Other sources are not probed.
 */
export function modelStatusSummary(args: {
  provider: string | null;
  dot: LlamaStatusDotState;
  warming: 'starting' | 'downloading' | null;
  status: LlamaServerStatusResult | null;
  model: string;
}): string {
  const { provider, dot, warming, status, model } = args;
  if (!provider) {
    return 'No model selected';
  }
  if (provider === 'openrouter') {
    return dot === 'green' ? `Connected · ${model}` : 'Needs a model and API key';
  }
  if (provider !== 'llamacpp') {
    return 'Not checked for this source';
  }
  if (warming === 'downloading') {
    return 'Downloading weights…';
  }
  if (warming === 'starting' || (status?.ok === true && status.starting)) {
    return 'Starting…';
  }
  if (!status || status.ok === false) {
    return 'Stopped';
  }
  const remote = status.remote === true;
  if (!status.running && !remote) {
    return 'Stopped';
  }
  switch (dot) {
    case 'green':
      return remote ? 'Connected' : 'Running';
    case 'yellow':
      return 'Loading model…';
    case 'red':
      return remote ? 'Not responding' : 'Error';
    default:
      return 'Stopped';
  }
}

/** One-line CPU embeddings status for the home Runtime panel. */
export function embeddingsStatusSummary(status: string | null): string {
  switch (status) {
    case 'ready':
      return 'Ready';
    case 'loading':
      return 'Loading…';
    case 'idle':
      return 'Loads on first search';
    case 'disabled':
      return 'Off';
    case 'error':
      return 'Error';
    default:
      return 'Unknown';
  }
}
