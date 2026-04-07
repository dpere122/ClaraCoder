/** Payload for SSE `copy_confirm` / chat copy confirmation card (mirrors Python `copy_confirm_sse_payload`). */
export interface CopyConfirmItem {
  sourcePath: string;
  destinationPath: string;
}

export interface CopyConfirmPayload {
  version: 1;
  requestId: string;
  copies: CopyConfirmItem[];
  overwrite: boolean;
}
