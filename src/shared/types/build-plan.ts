/** Payload for SSE `build_plan_open` — opens a preview-only Monaco tab for the plan MD file. */
export interface BuildPlanOpenPayload {
  planId: string;
  relativePath: string;
  title: string;
  previewMode: true;
}
