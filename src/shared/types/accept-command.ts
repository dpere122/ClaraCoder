/** Payload for SSE `accept_command` / chat generic approval card. */
export interface AcceptCommandPayload {
  version: 1;
  requestId: string;
  kind: string;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  commandText: string;
  details: string[];
  riskLevel?: 'low' | 'medium' | 'high';
  riskDescription?: string;
  riskAssessmentStatus?: 'ok' | 'failed';
}
