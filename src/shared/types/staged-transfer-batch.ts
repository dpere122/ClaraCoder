import type { FileDiffPayload } from './diff';

/** Per-file resolution within a batch staged transfer review. */
export type StagedTransferFileResolution = 'pending' | 'approved' | 're_review';

/** Payload for SSE `staged_transfer_batch` / chat batch staged transfer card. */
export interface StagedTransferBatchPayload {
  version: 1;
  requestId: string;
  files: FileDiffPayload[];
  /** True when the batch was queued because the agent ended with leftover untransferred drafts. */
  untransferredFlush?: boolean;
}
