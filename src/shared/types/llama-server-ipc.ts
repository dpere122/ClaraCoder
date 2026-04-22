/** Health probe result for managed llama-server subprocess (renderer + IPC). */
export type ManagedServerHealthState = 'ok' | 'loading' | 'stopped' | 'error';

export type LlamaServerStartResult = { ok: true } | { ok: false; error: string };

export interface LlamaServerStatusPayload {
  ok: true;
  running: boolean;
  modelId: string;
  chat: { port: number; health: ManagedServerHealthState; lastLog?: string };
  embed?: { port: number; health: ManagedServerHealthState; lastLog?: string };
}

export type LlamaServerStatusResult = LlamaServerStatusPayload | { ok: false; error: string };

/** Which managed ``llama-server`` process a stream belongs to (chat vs embedding). */
export type LlamaServerStreamKind = 'chat' | 'embed';

/** Chunk forwarded to the llama.cpp terminal tab (stdout and stderr). */
export interface LlamaServerOutputEvent {
  modelId: string;
  stream: LlamaServerStreamKind;
  /** Defaults to ``stdout`` when omitted (older main builds). */
  fd?: 'stdout' | 'stderr';
  data: string;
}

export interface LlamaServerProcessExitEvent {
  modelId: string;
  stream: LlamaServerStreamKind;
  code: number | null;
  signal: string | null;
}

export type LlamaServerLifecycleEvent =
  | { phase: 'starting'; modelId: string }
  | { phase: 'stopped'; modelId: string };
