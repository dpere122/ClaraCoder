import type { ConversationMessage, DiffReviewStatus } from '@shared/index';

/** Shown on HITL cards when SQLite still says pending but Python is not paused. */
export const STALE_HITL_SUMMARY = 'Stale — agent is no longer waiting';

const HITL_ARTIFACT_ROLES = new Set<ConversationMessage['role']>([
  'diff',
  'accept_command',
  'copy_confirm',
  'delete_confirm',
  'plan_confirm',
  'staged_transfer_batch',
  'agent_question',
]);

type HitlArtifactMessage = Extract<
  ConversationMessage,
  { reviewStatus?: DiffReviewStatus; reviewSummary?: string }
>;

function isHitlArtifactMessage(m: ConversationMessage): m is HitlArtifactMessage {
  return HITL_ARTIFACT_ROLES.has(m.role);
}

/**
 * Cancel pending HITL artifacts after a non-streaming load (Python pause state is gone).
 * Returns the same array reference when nothing changes.
 */
export function abandonStaleHitlMessages(messages: ConversationMessage[]): ConversationMessage[] {
  let changed = false;
  const next = messages.map((m) => {
    if (!isHitlArtifactMessage(m)) return m;
    if ((m.reviewStatus ?? 'pending') !== 'pending') return m;
    changed = true;
    return {
      ...m,
      reviewStatus: 'cancelled' as const,
      reviewSummary: STALE_HITL_SUMMARY,
    };
  });
  return changed ? next : messages;
}
