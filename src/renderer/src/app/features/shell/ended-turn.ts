/**
 * Settling a turn that ended before the agent finished it (stopped, interrupted by a new message,
 * or failed), so its partial progress can be kept: nothing in the saved reply should look like it
 * is still running or still waiting for an answer.
 */
import type { ConversationMessage, StreamPart, TurnEditedFile } from '@shared/index';
import { isInFlightToolPart } from '@shared/index';
import { isHitlArtifactMessage } from './abandon-stale-hitl';

/** Card summary for an approval the agent stopped waiting for because its turn ended. */
export const ENDED_TURN_HITL_SUMMARY = 'Cancelled — the turn ended before an answer';

/** Card summary for a sub-agent approval whose sub-agent is no longer running. */
export const SUBAGENT_ENDED_HITL_SUMMARY = 'Cancelled — the sub-agent is no longer waiting';

/**
 * Running tool rows become stopped (they have no result) and open command lanes close.
 * Returns the same array when nothing was in flight.
 */
export function settleInFlightStreamParts(parts: readonly StreamPart[]): StreamPart[] {
  let changed = false;
  const next = parts.map((part) => {
    if (!isInFlightToolPart(part)) {
      return part;
    }
    changed = true;
    if (part.toolChainState === 'running') {
      return { ...part, toolChainState: 'error' as const, toolStopped: true as const };
    }
    return { ...part, runComplete: true };
  });
  return changed ? next : (parts as StreamPart[]);
}

/** Index of the first message of the live (last) turn: just after the last user message. */
function liveTurnStart(messages: readonly ConversationMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') {
      return i + 1;
    }
  }
  return 0;
}

/**
 * Settle the live turn's transcript rows: running chain rows become errors and pending approval
 * cards are cancelled. Earlier turns are left alone. Returns the same array when nothing changes.
 */
export function settleLiveTurnMessages(
  messages: readonly ConversationMessage[],
  summary: string = ENDED_TURN_HITL_SUMMARY,
): ConversationMessage[] {
  const start = liveTurnStart(messages);
  let changed = false;
  const next = messages.map((m, i) => {
    if (i < start) {
      return m;
    }
    if (m.role === 'chain' && m.state === 'running') {
      changed = true;
      return { ...m, state: 'error' as const };
    }
    if (isHitlArtifactMessage(m) && (m.reviewStatus ?? 'pending') === 'pending' && !isSubagentCard(m)) {
      changed = true;
      return { ...m, reviewStatus: 'cancelled' as const, reviewSummary: summary };
    }
    return m;
  });
  return changed ? next : (messages as ConversationMessage[]);
}

/**
 * A card a sub-agent raised: it outlives the parent turn it showed up in, and is cancelled by
 * {@link cancelSubagentApprovals} when that sub-agent ends instead.
 */
function isSubagentCard(m: ConversationMessage): boolean {
  return (m.role === 'accept_command' || m.role === 'delete_confirm') && !!m.payload.subagent;
}

/**
 * Set `editedFiles` on the assistant message that closes the turn started by `userMessageId`
 * (the next assistant message before another user message). Returns the same array when there is
 * no such message.
 */
export function attachTurnEditedFiles(
  messages: readonly ConversationMessage[],
  userMessageId: string,
  files: readonly TurnEditedFile[],
): ConversationMessage[] {
  const userIdx = messages.findIndex((m) => m.role === 'user' && m.id === userMessageId);
  if (userIdx < 0) {
    return messages as ConversationMessage[];
  }
  for (let i = userIdx + 1; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === 'user') {
      break;
    }
    if (m.role === 'assistant') {
      const copy = [...messages];
      copy[i] = { ...m, editedFiles: [...files] };
      return copy;
    }
  }
  return messages as ConversationMessage[];
}

/**
 * Cancel pending approval cards a sub-agent raised in its parent's transcript (the sub-agent
 * finished or was stopped, so no one is waiting for them). Returns the same array when none match.
 */
export function cancelSubagentApprovals(
  messages: readonly ConversationMessage[],
  subagentConversationId: string,
): ConversationMessage[] {
  let changed = false;
  const next = messages.map((m) => {
    if (m.role !== 'accept_command' && m.role !== 'delete_confirm') {
      return m;
    }
    if ((m.reviewStatus ?? 'pending') !== 'pending' || m.payload.subagent?.conversationId !== subagentConversationId) {
      return m;
    }
    changed = true;
    return { ...m, reviewStatus: 'cancelled' as const, reviewSummary: SUBAGENT_ENDED_HITL_SUMMARY };
  });
  return changed ? next : (messages as ConversationMessage[]);
}
