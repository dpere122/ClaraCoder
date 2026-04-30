/** Health probe result for managed llama-server subprocess (renderer + IPC). */
export type ManagedServerHealthState = 'ok' | 'loading' | 'stopped' | 'error';

export type LlamaServerStartResult = { ok: true } | { ok: false; error: string };

export interface LlamaServerStatusPayload {
  ok: true;
  running: boolean;
  modelId: string;
  chat: { port: number; health: ManagedServerHealthState; lastLog?: string };
  embed?: { port: number; health: ManagedServerHealthState; lastLog?: string };
  /** Set when the preset has no Start command: ``baseUrl`` in settings is probed; no local Stop. */
  remote?: boolean;
}

export type LlamaServerStatusResult = LlamaServerStatusPayload | { ok: false; error: string };

/** ``GET /v1/models`` against a running managed chat ``llama-server`` (main process only). */
export type LlamacppManagedListModelsResult = { ok: true; models: string[] } | { ok: false; error: string };

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
  /** Remote weights are being fetched (e.g. ``-hf`` first run); UI may show fast crystal spin. */
  | { phase: 'downloading'; modelId: string }
  /** Chat (and embedding if configured) passed ``/health``; managed servers are ready. */
  | { phase: 'running'; modelId: string }
  | { phase: 'stopped'; modelId: string };
