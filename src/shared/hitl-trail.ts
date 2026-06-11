import { diffLineChangeCounts, formatDiffLineChangeSummary } from './diff-stats';
import type { DiffReviewStatus } from './types/conversation';
import type { PlanConfirmPayload } from './types/plan-confirm';
import type { AcceptCommandPayload } from './types/accept-command';
import type { CopyConfirmPayload } from './types/copy-confirm';
import type { DeleteConfirmPayload } from './types/delete-confirm';
import type { FileDiffPayload } from './types/diff';
import type { StagedTransferBatchPayload } from './types/staged-transfer-batch';

export type HitlTrailKind =
  | 'diff'
  | 'delete_confirm'
  | 'copy_confirm'
  | 'accept_command'
  | 'plan_confirm'
  | 'staged_transfer_batch';

export interface HitlTrailItem {
  id: string;
  kind: HitlTrailKind;
  /** Short label (usually basename). */
  label: string;
  /** Full path or detail string for tooltips. */
  detailPath?: string;
  /** Git-style line delta for diffs. */
  lineSummary?: string;
  reviewStatus: DiffReviewStatus;
  pending: boolean;
}

export type HitlTrailArtifact =
  | { role: 'diff'; payload: FileDiffPayload; reviewStatus?: DiffReviewStatus; reviewSummary?: string }
  | { role: 'delete_confirm'; payload: DeleteConfirmPayload; reviewStatus?: DiffReviewStatus; reviewSummary?: string }
  | { role: 'copy_confirm'; payload: CopyConfirmPayload; reviewStatus?: DiffReviewStatus; reviewSummary?: string }
  | { role: 'accept_command'; payload: AcceptCommandPayload; reviewStatus?: DiffReviewStatus; reviewSummary?: string }
  | { role: 'plan_confirm'; payload: PlanConfirmPayload; reviewStatus?: DiffReviewStatus; reviewSummary?: string }
  | {
      role: 'staged_transfer_batch';
      payload: StagedTransferBatchPayload;
      reviewStatus?: DiffReviewStatus;
      reviewSummary?: string;
      fileResolutions?: Record<string, 'pending' | 'approved' | 're_review'>;
    };

function pathBasename(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

function reviewStatusOf(status: DiffReviewStatus | undefined): DiffReviewStatus {
  return status ?? 'pending';
}

function diffTrailItem(
  payload: FileDiffPayload,
  reviewStatus: DiffReviewStatus | undefined,
  index: number,
): HitlTrailItem {
  const status = reviewStatusOf(reviewStatus);
  return {
    id: `diff:${payload.relativePath}:${index}`,
    kind: 'diff',
    label: pathBasename(payload.relativePath),
    detailPath: payload.relativePath,
    lineSummary: formatDiffLineChangeSummary(diffLineChangeCounts(payload.rows)),
    reviewStatus: status,
    pending: status === 'pending',
  };
}

function deleteTrailItems(
  payload: DeleteConfirmPayload,
  reviewStatus: DiffReviewStatus | undefined,
): HitlTrailItem[] {
  const status = reviewStatusOf(reviewStatus);
  const entries =
    payload.entries && payload.entries.length > 0
      ? payload.entries
      : payload.relativePath
        ? [{ relativePath: payload.relativePath, kind: payload.kind ?? 'file', recursive: !!payload.recursive }]
        : [];
  return entries.map((entry, index) => ({
    id: `delete:${payload.requestId}:${index}`,
    kind: 'delete_confirm' as const,
    label: pathBasename(entry.relativePath),
    detailPath: entry.relativePath,
    lineSummary: entry.kind === 'directory' ? 'dir' : undefined,
    reviewStatus: status,
    pending: status === 'pending',
  }));
}

function copyTrailItems(
  payload: CopyConfirmPayload,
  reviewStatus: DiffReviewStatus | undefined,
): HitlTrailItem[] {
  const status = reviewStatusOf(reviewStatus);
  return payload.copies.map((copy, index) => ({
    id: `copy:${payload.requestId}:${index}`,
    kind: 'copy_confirm' as const,
    label: pathBasename(copy.destinationPath),
    detailPath: `${copy.sourcePath} → ${copy.destinationPath}`,
    reviewStatus: status,
    pending: status === 'pending',
  }));
}

function planConfirmTrailItem(
  payload: PlanConfirmPayload,
  reviewStatus: DiffReviewStatus | undefined,
): HitlTrailItem {
  const status = reviewStatusOf(reviewStatus);
  const stepCount = payload.steps?.length ?? 0;
  return {
    id: `plan:${payload.requestId}`,
    kind: 'plan_confirm',
    label: payload.title.trim() || 'Plan',
    detailPath: stepCount > 0 ? `${stepCount} step(s)` : undefined,
    reviewStatus: status,
    pending: status === 'pending',
  };
}
function acceptCommandTrailItem(
  payload: AcceptCommandPayload,
  reviewStatus: DiffReviewStatus | undefined,
): HitlTrailItem {
  const status = reviewStatusOf(reviewStatus);
  return {
    id: `accept:${payload.requestId}`,
    kind: 'accept_command',
    label: payload.title.trim() || 'Approval',
    detailPath: payload.commandText.trim() || undefined,
    reviewStatus: status,
    pending: status === 'pending',
  };
}

function stagedTransferBatchTrailItems(
  artifact: Extract<HitlTrailArtifact, { role: 'staged_transfer_batch' }>,
): HitlTrailItem[] {
  const batchStatus = reviewStatusOf(artifact.reviewStatus);
  const resolutions = artifact.fileResolutions ?? {};
  return artifact.payload.files.map((file, index) => {
    const rel = file.relativePath;
    const fileRes = resolutions[rel] ?? 'pending';
    let reviewStatus: DiffReviewStatus = batchStatus;
    let pending = batchStatus === 'pending';
    if (batchStatus === 'pending') {
      if (fileRes === 'approved') {
        reviewStatus = 'complete';
        pending = false;
      } else if (fileRes === 're_review') {
        reviewStatus = 'cancelled';
        pending = false;
      } else {
        pending = true;
      }
    }
    return {
      id: `staged:${artifact.payload.requestId}:${index}`,
      kind: 'staged_transfer_batch' as const,
      label: pathBasename(rel),
      detailPath: rel,
      lineSummary: formatDiffLineChangeSummary(diffLineChangeCounts(file.rows)),
      reviewStatus,
      pending,
    };
  });
}

/** Flatten HITL artifacts into compact trail rows for the chat panel list. */
export function hitlTrailItemsFromArtifacts(artifacts: readonly HitlTrailArtifact[]): HitlTrailItem[] {
  const out: HitlTrailItem[] = [];
  for (const artifact of artifacts) {
    switch (artifact.role) {
      case 'diff':
        out.push(diffTrailItem(artifact.payload, artifact.reviewStatus, out.length));
        break;
      case 'delete_confirm':
        out.push(...deleteTrailItems(artifact.payload, artifact.reviewStatus));
        break;
      case 'copy_confirm':
        out.push(...copyTrailItems(artifact.payload, artifact.reviewStatus));
        break;
      case 'accept_command':
        out.push(acceptCommandTrailItem(artifact.payload, artifact.reviewStatus));
        break;
      case 'plan_confirm':
        out.push(planConfirmTrailItem(artifact.payload, artifact.reviewStatus));
        break;
      case 'staged_transfer_batch':
        out.push(...stagedTransferBatchTrailItems(artifact));
        break;
      default:
        break;
    }
  }
  return out;
}

export function hitlTrailPanelTitle(items: readonly HitlTrailItem[], live: boolean): string {
  if (items.length === 0) {
    return 'Changes';
  }
  const pending = items.filter((i) => i.pending).length;
  if (live && pending > 0) {
    return pending === 1 ? '1 pending' : `${pending} pending`;
  }
  if (items.length === 1) {
    return '1 change';
  }
  return `${items.length} changes`;
}

export function hitlTrailKindLabel(kind: HitlTrailKind): string {
  switch (kind) {
    case 'diff':
      return 'edit';
    case 'delete_confirm':
      return 'delete';
    case 'copy_confirm':
      return 'copy';
    case 'accept_command':
      return 'approve';
    case 'plan_confirm':
      return 'plan';
    case 'staged_transfer_batch':
      return 'transfer';
    default:
      return kind;
  }
}

export function hitlTrailStatusLabel(status: DiffReviewStatus): string {
  switch (status) {
    case 'complete':
      return 'ok';
    case 'cancelled':
      return 'skip';
    default:
      return '…';
  }
}

/** Single compact kind pill, e.g. `edit +12 −4 ok`. */
export function hitlTrailRowKindText(item: HitlTrailItem): string {
  const parts: string[] = [hitlTrailKindLabel(item.kind)];
  if (item.lineSummary?.trim()) {
    parts.push(item.lineSummary.trim());
  }
  if (!item.pending) {
    parts.push(hitlTrailStatusLabel(item.reviewStatus));
  }
  return parts.join(' ');
}
