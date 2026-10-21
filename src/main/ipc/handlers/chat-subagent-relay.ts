import { randomUUID } from 'crypto';
import type {
  ConversationFile,
  ConversationMeta,
  ParsedAgentStreamPayload,
  SubagentOutcome,
  SubagentResultsReadyEvent,
  SubagentStartedEvent,
} from '../../../shared';
import { FIRST_THEME_ID } from '../../constants';
import { createSubagentConversation, getConversationById, isConversationDeleted } from '../../conversations-db';
import { pythonControlFetch } from '../../python/http-client';
import { dispatchParsedPayload, persistFileJournal, type RendererSend } from './chat-stream-payload';

/** Sub-agent ids are Python uuids; anything else is not a conversation id main will create. */
const SUBAGENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

interface RelayedSubagent {
  name: string;
  parentConversationId: string;
  /** The parent user message whose turn spawned it (its edits are journaled under that turn). */
  parentTurnId: string;
  /** Id of the task message main wrote into the sub-agent conversation (its turn's id). */
  userMessageId: string;
  finished: boolean;
}

/**
 * Routes the sub-agent event channel (Python `GET /subagents/events`) to the renderer. Sub-agents
 * outlive the parent turn that spawned them, so their events do not ride a chat stream: the relay
 * creates each sub-agent's conversation row, forwards its stream under its own id, re-targets its
 * approval cards to the parent's dock, journals its edits on the parent turn, and passes on
 * "results ready" so the renderer can hand the reports to a parent that has no turn running.
 */
export interface SubagentRelay {
  /** Handle one parsed channel payload. Returns false when it is not a sub-agent event. */
  handle(parsed: ParsedAgentStreamPayload): boolean;
  /** Settle every sub-agent that never reported `subagent_finished` (e.g. the sidecar restarted). */
  finishAll(outcome: SubagentOutcome): void;
  /** Sub-agents started and not finished yet (tests, diagnostics). */
  runningIds(): string[];
}

async function postBestEffort(route: string, body: Record<string, unknown>): Promise<void> {
  try {
    await pythonControlFetch(route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(`[Subagents] ${route} failed:`, err);
  }
}

/**
 * @param rendererFor where to deliver events about a parent conversation's sub-agents (the
 *   renderer that runs the parent's turns).
 */
export function createSubagentRelay(rendererFor: (parentConversationId: string) => RendererSend): SubagentRelay {
  const children = new Map<string, RelayedSubagent>();

  const start = (parsed: Extract<ParsedAgentStreamPayload, { type: 'subagent_started' }>): void => {
    const id = parsed.conversationId;
    const parentId = parsed.parentConversationId ?? '';
    if (!SUBAGENT_ID_PATTERN.test(id) || !parentId || id === parentId || children.has(id)) {
      return;
    }
    if (isConversationDeleted(parentId)) {
      return;
    }
    const parent = getConversationById(parentId);
    // Sub-agents cannot spawn, so a sub-agent conversation is never a parent.
    if (!parent || parent.parentConversationId) {
      return;
    }
    const parentTurnId = parsed.parentTurnId ?? '';
    const now = new Date().toISOString();
    const userMessageId = randomUUID();
    const conv: ConversationFile = {
      id,
      title: parsed.name,
      createdAt: now,
      updatedAt: now,
      messages: [{ role: 'user', id: userMessageId, text: parsed.task, fromAgent: true }],
      // The parent's workspace, never one Python names: the row lands where its parent is listed.
      workspaceId: parent.workspaceId,
      themeId: parent.themeId || FIRST_THEME_ID,
      customTitle: true,
      parentConversationId: parentId,
      ...(parentTurnId ? { parentTurnId } : {}),
    };
    // Insert-only: an id that already names a conversation (or was deleted) is never taken over.
    if (!createSubagentConversation(conv)) {
      return;
    }
    children.set(id, { name: parsed.name, parentConversationId: parentId, parentTurnId, userMessageId, finished: false });
    const meta: ConversationMeta = {
      id,
      title: conv.title,
      createdAt: now,
      updatedAt: now,
      workspaceId: conv.workspaceId,
      customTitle: true,
      parentConversationId: parentId,
      ...(parentTurnId ? { parentTurnId } : {}),
    };
    // The row exists before the renderer hears of it, so its first background save finds it.
    rendererFor(parentId)('subagent-started', {
      meta,
      task: parsed.task,
      userMessageId,
      ...(parsed.statusId ? { statusId: parsed.statusId } : {}),
      ...(parsed.background ? { background: true } : {}),
    } satisfies SubagentStartedEvent);
  };

  const relayEvent = (childId: string, child: RelayedSubagent, inner: ParsedAgentStreamPayload): void => {
    const subagent = { conversationId: childId, name: child.name };
    const parentId = child.parentConversationId;
    const send = rendererFor(parentId);
    switch (inner.type) {
      case 'accept_command':
        // Approval cards show in the parent's dock; the answer goes to the sub-agent's session.
        send('message-accept-command', parentId, { ...inner.acceptCommand, subagent });
        return;
      case 'delete_confirm':
        send('message-delete-confirm', parentId, { ...inner.deleteConfirm, subagent });
        return;
      case 'file_journal':
        // A sub-agent's edits belong to the parent turn that spawned it (restore reverts them).
        persistFileJournal(parentId, {
          ...inner.fileJournal,
          userMessageId: child.parentTurnId || inner.fileJournal.userMessageId,
        });
        return;
      case 'plan_confirm':
        // No one could answer this card; cancel it so the sub-agent does not wait forever.
        void postBestEffort('/chat/agent-continue', {
          session_id: childId,
          note: '',
          plan_confirm_action: 'cancel',
          plan_confirm_request_id: inner.planConfirm.requestId ?? '',
        });
        return;
      case 'agent_question':
        void postBestEffort('/chat/agent-question-answers', {
          session_id: childId,
          request_id: inner.agentQuestion.requestId ?? '',
          action: 'cancel',
          answers: [],
        });
        return;
      case 'theme_proposal':
      case 'planner_progress':
      case 'build_plan_open':
      case 'build_plan_chunk':
      case 'build_plan_stream_end':
        // Plan-mode and theme surfaces belong to the conversation the user is typing in.
        return;
      default:
        dispatchParsedPayload(send, childId, inner);
    }
  };

  const finish = (childId: string, child: RelayedSubagent, outcome: SubagentOutcome): void => {
    child.finished = true;
    rendererFor(child.parentConversationId)('message-done', childId, outcome, [], child.userMessageId);
  };

  return {
    handle(parsed) {
      switch (parsed.type) {
        case 'subagent_started':
          start(parsed);
          return true;
        case 'subagent_event': {
          const child = children.get(parsed.conversationId);
          if (child && !child.finished && parsed.payload) {
            relayEvent(parsed.conversationId, child, parsed.payload);
          }
          return true;
        }
        case 'subagent_finished': {
          const child = children.get(parsed.conversationId);
          if (child && !child.finished) {
            finish(parsed.conversationId, child, parsed.outcome);
            children.delete(parsed.conversationId);
          }
          return true;
        }
        case 'subagent_results_ready':
          if (!isConversationDeleted(parsed.parentConversationId)) {
            rendererFor(parsed.parentConversationId)('subagent-results-ready', {
              parentConversationId: parsed.parentConversationId,
              names: parsed.names,
            } satisfies SubagentResultsReadyEvent);
          }
          return true;
        default:
          return false;
      }
    },

    finishAll(outcome) {
      for (const [childId, child] of children) {
        if (!child.finished) {
          finish(childId, child, outcome);
        }
      }
      children.clear();
    },

    runningIds() {
      return [...children.keys()];
    },
  };
}
