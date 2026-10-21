import type { ConversationMeta } from './conversation';

/** A sub-agent the main agent spawned: its conversation id (also its Python session id) and label. */
export interface SubagentRef {
  conversationId: string;
  name: string;
}

/**
 * IPC `subagent-started`: main created the sub-agent's conversation row and is about to forward its
 * stream. `userMessageId` is the id of the task message main wrote into that conversation, so the
 * renderer can match the sub-agent turn's `message-done`.
 */
export interface SubagentStartedEvent {
  meta: ConversationMeta;
  task: string;
  userMessageId: string;
  /** Status id of the parent's `spawn_subagent` pill, when the backend knew it. */
  statusId?: string;
  /** The parent agent kept working instead of waiting for this sub-agent's report. */
  background?: boolean;
}

/**
 * IPC `subagent-results-ready`: sub-agent reports are waiting for a parent conversation that has
 * no turn running, so the renderer starts one to hand them to the main agent.
 */
export interface SubagentResultsReadyEvent {
  parentConversationId: string;
  /** Sub-agents whose reports are waiting. */
  names: string[];
}

/** How a sub-agent's one turn ended, as reported by `subagent_finished`. */
export type SubagentOutcome = 'completed' | 'aborted' | 'error';
