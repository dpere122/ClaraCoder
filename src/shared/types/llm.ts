/** Legacy tier from Python ``agent_role`` (optional on persisted chain rows). */
export type LlmAgentRole = 'manager' | 'worker';

export type PlannerStepState = 'pending' | 'running' | 'complete' | 'error';

export interface PlannerStep {
  id: string;
  text: string;
  state: PlannerStepState;
}

export interface PlannerProgress {
  streamTag: string;
  phase: 'discovery' | 'planning' | 'executing' | 'complete' | 'error';
  planReady?: boolean;
  steps: PlannerStep[];
  activeStepId?: string;
  finalReviewState?: PlannerStepState;
  finalReviewAttempts?: number;
  finalReviewMaxAttempts?: number;
  finalReviewSummary?: string;
}

/**
 * Clara streaming/processing tier in the chat UI.
 * Maps from {@link LlmAgentRole} while a reply is in flight (single-agent uses `CLARA_AGENT`).
 */
export type ClaraAgentMode = 'CLARA_AGENT' | 'CLARA_MANAGER' | 'CLARA_WORKER';

export function claraModeFromLlmRole(role: LlmAgentRole | null): ClaraAgentMode {
  if (role === 'manager') return 'CLARA_MANAGER';
  if (role === 'worker') return 'CLARA_WORKER';
  return 'CLARA_AGENT';
}

/** Streaming status / tool row payload sent renderer → UI over IPC. */
export interface LlmStatus {
  id: string;
  label: string;
  detail: string;
  state: 'running' | 'complete' | 'error';
  source: 'agent' | 'tool';
  streamTag?: string;
  /** When set, chain row pill shows Manager / Worker instead of generic AGENT. */
  agentRole?: LlmAgentRole;
}

/** Same shape as {@link LlmStatus}; used when parsing SSE JSON from the Python backend. */
export type LlmStatusPayload = LlmStatus;
