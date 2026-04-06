/** Payload for SSE `delete_confirm` / chat delete confirmation card (mirrors Python `delete_confirm_sse_payload`). */
export interface DeleteConfirmPayload {
  version: 1;
  requestId: string;
  relativePath: string;
  kind: 'file' | 'directory';
  recursive: boolean;
}
