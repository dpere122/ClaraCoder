/** Payload for SSE `plan_confirm` / chat plan approval card. */
export interface PlanConfirmPayload {
  version: 1;
  requestId: string;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  steps: string[];
}
