/** Streaming status / tool row payload sent renderer → UI over IPC. */
export interface LlmStatus {
  id: string;
  label: string;
  detail: string;
  state: 'running' | 'complete' | 'error';
  source: 'agent' | 'tool';
}

/** Same shape as {@link LlmStatus}; used when parsing SSE JSON from the Python backend. */
export type LlmStatusPayload = LlmStatus;
