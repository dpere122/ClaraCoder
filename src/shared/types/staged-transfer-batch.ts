import type { FileDiffPayload } from './diff';

/** Per-file resolution within a batch staged transfer review. */
export type StagedTransferFileResolution = 'pending' | 'approved' | 're_review';

/**
 * Payload of the retired batch staged-transfer card. The staging pipeline is gone; this type stays
 * only so `staged_transfer_batch` messages saved in older conversations still load and show read-only.
 */
export interface StagedTransferBatchPayload {
  version: 1;
  requestId: string;
  files: FileDiffPayload[];
  /** True when the batch was queued because the agent ended with leftover untransferred drafts. */
  untransferredFlush?: boolean;
}
