/** Payload for SSE `build_plan_open` — opens a preview-only Monaco tab for the plan MD file. */
export interface BuildPlanOpenPayload {
  planId: string;
  relativePath: string;
  title: string;
  previewMode: true;
}

/** Payload for SSE `build_plan_chunk` — live markdown content while the planner streams. */
export interface BuildPlanChunkPayload {
  relativePath: string;
  content: string;
}

/** Payload for SSE `build_plan_stream_end` — planner finished streaming markdown. */
export interface BuildPlanStreamEndPayload {
  relativePath: string;
}
