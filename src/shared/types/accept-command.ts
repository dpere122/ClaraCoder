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
}

/** User decision on an accept-command HITL card. */
export type AcceptCommandAction = 'confirm' | 'confirm_session' | 'cancel' | 'deny';

export interface AcceptCommandFinishedEvent {
  requestId: string;
  status: 'complete' | 'cancelled';
  summary?: string;
  action?: AcceptCommandAction;
  kind?: string;
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
