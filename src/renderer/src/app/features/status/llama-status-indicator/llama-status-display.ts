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
