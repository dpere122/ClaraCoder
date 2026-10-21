import type { SubagentRef } from './subagent';

/** Composer Admin chip: grant the agent elevated ``run_command`` for this conversation. */
export const ACCEPT_COMMAND_KIND_ADMIN_ELEVATION = 'admin_elevation';
/** Agent-requested Admin grant (same card; resumes the paused tool after Allow). */
export const ACCEPT_COMMAND_KIND_ADMIN_ELEVATION_TOOL = 'admin_elevation_tool';

export function isAdminElevationKind(kind: string | undefined): boolean {
  return kind === ACCEPT_COMMAND_KIND_ADMIN_ELEVATION || kind === ACCEPT_COMMAND_KIND_ADMIN_ELEVATION_TOOL;
}

/** Payload for SSE `accept_command` / chat generic approval card. */
export interface AcceptCommandPayload {
  version: 1;
  requestId: string;
  kind: string;
  title: string;
  message: string;
  confirmLabel: string;
  /** When set, the card offers a third action that remembers elevation for this session. */
  confirmSessionLabel?: string;
  cancelLabel: string;
  commandText: string;
  details: string[];
  riskLevel?: 'low' | 'medium' | 'high';
  riskDescription?: string;
  riskAssessmentStatus?: 'ok' | 'failed';
  /** Set when `kind` is `mcp_tool`, so Allow / Deny can be stored on that server. */
  mcpServerId?: string;
  mcpToolName?: string;
  /**
   * Set by main (never by the backend) when a sub-agent asked: the card shows in the parent's dock
   * and the answer goes to the sub-agent's session.
   */
  subagent?: SubagentRef;
}

/** User decision on an accept-command HITL card. */
export type AcceptCommandAction = 'confirm' | 'confirm_session' | 'cancel' | 'deny';

export interface AcceptCommandFinishedEvent {
  requestId: string;
  status: 'complete' | 'cancelled';
  summary?: string;
  action?: AcceptCommandAction;
  kind?: string;
  /** Set when the card came from a sub-agent: its grants belong to that session, not the composer. */
  subagentConversationId?: string;
}

/** Deferred tool card (e.g. an elevated `run_command`); Python's `ACCEPT_COMMAND_KIND_DEFERRED_TOOL`. */
export const ACCEPT_COMMAND_KIND_DEFERRED_TOOL = 'deferred_tool';

/**
 * Whether a finished card turns the composer Admin chip on. Admin cards do; "for this session"
 * only on a deferred tool card, matching the Python grant for elevated `run_command`. Other
 * cards' session action (MCP "Allow all tools from this server") never grants Admin.
 */
export function acceptCommandGrantsAdminElevation(event: AcceptCommandFinishedEvent): boolean {
  if (event.status !== 'complete') {
    return false;
  }
  if (isAdminElevationKind(event.kind)) {
    return true;
  }
  return event.action === 'confirm_session' && event.kind === ACCEPT_COMMAND_KIND_DEFERRED_TOOL;
}

/** HITL card for turning the composer Admin chip on (agent-wide ability, not one command). */
export function createAdminElevationAcceptPayload(
  requestId: string,
  kind: string = ACCEPT_COMMAND_KIND_ADMIN_ELEVATION,
): AcceptCommandPayload {
  return {
    version: 1,
    requestId,
    kind,
    title: 'Grant administrator access',
    message:
      'Allow this agent to run shell commands with administrator or root privileges for this conversation. ' +
      'A Windows UAC or polkit prompt will appear after you click Allow.',
    confirmLabel: 'Allow',
    cancelLabel: 'Cancel',
    commandText: '',
    details: [
      'Applies to this conversation only',
      'Approve the system prompt now to start the elevated helper',
      'Turn off Admin in the composer to revoke',
    ],
  };
}
