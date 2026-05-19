/** Shapes mirror {@link ElectronService} IPC payloads; kept local to avoid circular imports. */
export interface BatchChunkMessage {
  conversationId: string;
  delta: string;
  streamTag?: string;
}

export interface BatchToolReadChunkMessage {
  conversationId: string;
  delta: string;
}

export interface BatchToolExecChunkMessage {
  conversationId: string;
  delta: string;
  streamTag?: string;
  label?: string;
}

export interface BatchToolExecCompleteMessage {
  conversationId: string;
  streamTag?: string;
  label?: string;
  exitCode?: number | null;
  outputExcerpt?: string;
  outcome?: 'passed' | 'failed';
}

/** One IPC-derived stream item in arrival order (preserves interleaving across kinds). */
export type StreamBatchItem =
  | { kind: 'chunk'; msg: BatchChunkMessage }
  | { kind: 'toolRead'; msg: BatchToolReadChunkMessage }
  | { kind: 'toolExec'; msg: BatchToolExecChunkMessage }
  | { kind: 'toolExecComplete'; msg: BatchToolExecCompleteMessage };

function streamTagKey(tag: string | undefined): string {
  return tag?.trim() ? tag.trim() : '';
}

/**
 * Merges consecutive token/tool-read/tool-exec deltas that belong to the same logical stream
 * so one animation frame can emit fewer Subject notifications.
 */
export function mergeStreamBatchQueue(queue: readonly StreamBatchItem[]): StreamBatchItem[] {
  const out: StreamBatchItem[] = [];
  for (const item of queue) {
    const last = out[out.length - 1];
    if (!last || last.kind !== item.kind) {
      out.push(
        item.kind === 'chunk'
          ? { kind: 'chunk', msg: { ...item.msg } }
          : item.kind === 'toolRead'
            ? { kind: 'toolRead', msg: { ...item.msg } }
            : item.kind === 'toolExecComplete'
              ? { kind: 'toolExecComplete', msg: { ...item.msg } }
              : { kind: 'toolExec', msg: { ...item.msg } },
      );
      continue;
    }
    if (item.kind === 'chunk' && last.kind === 'chunk') {
      const a = last.msg;
      const b = item.msg;
      if (a.conversationId === b.conversationId && streamTagKey(a.streamTag) === streamTagKey(b.streamTag)) {
        a.delta += b.delta;
        continue;
      }
    }
    if (item.kind === 'toolRead' && last.kind === 'toolRead') {
      const a = last.msg;
      const b = item.msg;
      if (a.conversationId === b.conversationId) {
        a.delta += b.delta;
        continue;
      }
    }
    if (item.kind === 'toolExec' && last.kind === 'toolExec') {
      const a = last.msg;
      const b = item.msg;
      if (
        a.conversationId === b.conversationId &&
        streamTagKey(a.streamTag) === streamTagKey(b.streamTag) &&
        (a.label ?? '') === (b.label ?? '')
      ) {
        a.delta += b.delta;
        continue;
      }
    }
    out.push(
      item.kind === 'chunk'
        ? { kind: 'chunk', msg: { ...item.msg } }
        : item.kind === 'toolRead'
          ? { kind: 'toolRead', msg: { ...item.msg } }
          : item.kind === 'toolExecComplete'
            ? { kind: 'toolExecComplete', msg: { ...item.msg } }
            : { kind: 'toolExec', msg: { ...item.msg } },
    );
  }
  return out;
}
