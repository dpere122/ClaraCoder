import { parseAgentStreamPayload } from '../../../shared';
import { pythonSseGet } from '../../python/http-client';
import { isPythonHealthy } from '../../python/server';
import { mainState } from '../../state';
import { createSubagentRelay, type SubagentRelay } from './chat-subagent-relay';
import { conversationRenderer } from './conversation-renderers';

/** Pause before reconnecting after the channel closed or the sidecar was unreachable. */
const RECONNECT_DELAY_MS = 1500;

let pumpAbort: AbortController | null = null;
let relay: SubagentRelay | null = null;

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** Feed every `data:` event of one SSE text block to the relay. */
export function handleSubagentEventBlock(block: string, target: SubagentRelay): void {
  for (const line of block.split('\n')) {
    if (!line.startsWith('data: ')) {
      continue;
    }
    const payload = line.slice(6).trim();
    if (!payload) {
      continue;
    }
    try {
      target.handle(parseAgentStreamPayload(payload));
    } catch (err) {
      // One bad event (e.g. a SQLite error creating its row) must not end the read: Python never
      // resends the events after it.
      console.error('[Subagents] handling an event failed:', err);
    }
  }
}

/** One connection to `GET /subagents/events`, until it closes or `signal` aborts. */
async function readChannel(signal: AbortSignal, target: SubagentRelay): Promise<void> {
  const res = await pythonSseGet('/subagents/events', {
    headers: { Accept: 'text/event-stream' },
    signal,
  });
  if (!res.ok || !res.body) {
    // Release the connection now (a persistent 401/404 retries every few seconds).
    await res.body?.cancel().catch(() => undefined);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      handleSubagentEventBlock(block, target);
    }
  }
}

async function pumpLoop(signal: AbortSignal, target: SubagentRelay): Promise<void> {
  let connectedSidecar: number | string | null = null;
  while (!signal.aborted) {
    try {
      if (await isPythonHealthy()) {
        const sidecar = mainState.pythonProcess?.pid ?? 'external';
        if (connectedSidecar !== null && sidecar !== connectedSidecar) {
          // A new sidecar: the old one's sub-agents are gone and will never report.
          target.finishAll('error');
        }
        connectedSidecar = sidecar;
        await readChannel(signal, target);
      }
    } catch (err) {
      if (!signal.aborted) {
        console.warn('[Subagents] event channel dropped:', err instanceof Error ? err.message : err);
      }
    }
    await delay(RECONNECT_DELAY_MS, signal);
  }
}

/** Keep the sub-agent event channel open for the app's lifetime (reconnects across sidecar restarts). */
export function startSubagentEventPump(): void {
  if (pumpAbort) {
    return;
  }
  pumpAbort = new AbortController();
  // A sub-agent outlives the turn that spawned it, so its events are not replies to a chat stream:
  // they go to the renderer that runs its parent's turns.
  relay = createSubagentRelay(conversationRenderer);
  void pumpLoop(pumpAbort.signal, relay);
}

export function stopSubagentEventPump(): void {
  pumpAbort?.abort();
  pumpAbort = null;
  relay = null;
}
