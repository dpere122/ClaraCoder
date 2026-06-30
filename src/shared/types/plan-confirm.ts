/** Payload for SSE `plan_confirm` / chat plan approval card. */
export interface PlanConfirmPayload {
  version: 1;
  requestId: string;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  steps: string[];
  /** Workspace-relative path to the build plan markdown file (preview tab). */
  buildPlanPath?: string;
  /** Build plan id linked to the preview tab and cancel API. */
  planId?: string;
}
