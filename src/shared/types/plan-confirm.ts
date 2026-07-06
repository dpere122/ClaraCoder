/** Payload for SSE `plan_confirm` / chat plan approval card. */
export interface PlanConfirmResolvedQuestion {
  prompt: string;
  answer: string;
}

export interface PlanConfirmPayload {
  version: 1;
  requestId: string;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  steps: string[];
  /** Files the plan proposes to change (path — rationale). */
  filesToChange: string[];
  /** Relevant existing behavior from discovery. */
  currentImplementation: string;
  /** Per-step risks unioned for at-a-glance review. */
  risks: string[];
  /** Plan-level outcomes that prove the objective is met. */
  definitionOfDone: string[];
  /** Open questions the user already answered during the question-card phase. */
  resolvedQuestions: PlanConfirmResolvedQuestion[];
  /** Workspace-relative path to the build plan markdown file (preview tab). */
  buildPlanPath?: string;
  /** Build plan id linked to the preview tab and cancel API. */
  planId?: string;
}
