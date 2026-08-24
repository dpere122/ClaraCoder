import type { LlamaServerStatusResult, ManagedServerHealthState } from '@shared/index';

/** Traffic-light state for a single managed server dot (model / embeddings). */
export type LlamaStatusDotState = 'green' | 'yellow' | 'red';

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
    default:
      // 'stopped' | 'error' | 'off'
      return 'red';
  }
}

/** Map a CPU Nomic embeddings load status (from Python ``GET /embeddings/status``) to a dot. */
export function embeddingsStatusDotState(status: string): LlamaStatusDotState {
  switch (status) {
    case 'ready':
      return 'green';
    case 'loading':
      return 'yellow';
    default:
      // 'idle' | 'error' | 'disabled'
      return 'red';
  }
}
