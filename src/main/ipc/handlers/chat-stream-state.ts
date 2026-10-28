import { pythonControlFetch } from '../../python/http-client';

/** Per-conversation abort controllers so the renderer can cancel an in-flight stream. */
const streamAbortControllers = new Map<string, AbortController>();
/** Workspace id for each active stream (used by settings window leave guards). */
const streamWorkspaceByConversationId = new Map<string, string | null>();

/** An approval card a live turn is blocked on, as the renderer IPC that delivered it. */
export interface WaitingCard {
  channel: string;
  payload: { requestId?: string };
}

/** What a renderer needs to rejoin a live turn after it reloaded (see {@link getLiveTurn}). */
export interface LiveTurn {
  userMessageId: string;
  waitingCards: WaitingCard[];
}

/** Live turn of each active stream: its user message id and the cards it waits on, by request id. */
const liveTurns = new Map<string, { userMessageId: string; cards: Map<string, WaitingCard> }>

function conversationWorkspaceMatches(
  conversationWorkspaceId: string | null | undefined,
  workspaceId: string | null,
): boolean {
  return (conversationWorkspaceId ?? null) === workspaceId;
}

export function getPendingStreamIdsForWorkspace(workspaceId: string | null): string[] {
  return [...streamAbortControllers.keys()].filter((conversationId) =>
    conversationWorkspaceMatches(streamWorkspaceByConversationId.get(conversationId), workspaceId),
  );
}

/**
 * Streams cancelled because a newer stream for the same conversation replaced them. Their
 * `message-done` must not reach the renderer: it carries only the conversation id, so it
 * would settle the replacement turn the renderer is now showing.
 */
const supersededControllers = new WeakSet<AbortController>();

export function beginChatStream(
  conversationId: string,
  workspaceId: string | null,
  userMessageId = '',
): AbortController {
  const previous = streamAbortControllers.get(conversationId);
  if (previous) {
    supersededControllers.add(previous);
    previous.abort();
  }
  const abortController = new AbortController();
  streamAbortControllers.set(conversationId, abortController);
  streamWorkspaceByConversationId.set(conversationId, workspaceId);
  liveTurns.set(conversationId, { userMessageId, cards: new Map() });
  return abortController;
}

/** Keep a card the live turn now waits on, so a renderer that reloads can show it again. */
export function rememberWaitingCard(conversationId: string, card: WaitingCard): void {
  const requestId = card.payload.requestId ?? '';
  const turn = liveTurns.get(conversationId);
  if (turn && requestId) {
    turn.cards.set(requestId, card);
  }
}

/** The card with `requestId` was answered (or its answer was sent): it no longer waits. */
export function forgetWaitingCard(conversationId: string, requestId: string | undefined): void {
  if (requestId) {
    liveTurns.get(conversationId)?.cards.delete(requestId);
  }
}

/** The live turn of `conversationId`, or null when no stream is open for it. */
export function getLiveTurn(conversationId: string): LiveTurn | null {
  const turn = liveTurns.get(conversationId);
  if (!turn || !streamAbortControllers.has(conversationId)) {
    return null;
  }
  return { userMessageId: turn.userMessageId, waitingCards: [...turn.cards.values()] };
}

/** True while a `/chat/stream` for this conversation is open. */
export function hasActiveChatStream(conversationId: string): boolean {
  return streamAbortControllers.has(conversationId);
}

/** True when `controller`'s stream was cancelled by a newer stream for the same conversation. */
export function wasChatStreamSuperseded(controller: AbortController): boolean {
  return supersededControllers.has(controller);
}

export function endChatStream(conversationId: string, controller?: AbortController): void {
  // Only delete the controller we started with. A newer stream may have replaced
  // us in the map; deleting unconditionally would drop the replacement's controller
  // and leave it uncancellable.
  if (controller && streamAbortControllers.get(conversationId) !== controller) {
    return;
  }
  streamAbortControllers.delete(conversationId);
  streamWorkspaceByConversationId.delete(conversationId);
  liveTurns.delete(conversationId);
}

export async function abortChatStream(conversationId: string): Promise<{ ok: boolean; error?: string }> {
  const controller = streamAbortControllers.get(conversationId);
  if (controller) {
    controller.abort();
    streamAbortControllers.delete(conversationId);
    streamWorkspaceByConversationId.delete(conversationId);
    liveTurns.delete(conversationId);
  }
  try {
    await pythonControlFetch('/chat/abort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: conversationId }),
    });
  } catch {
    // Best-effort: Python abort may fail if stream already ended.
    if (!controller) {
      return { ok: false, error: 'No active stream' };
    }
  }
  return { ok: true };
}
