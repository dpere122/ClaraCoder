import { pythonControlFetch } from '../../python/http-client';

/** Per-conversation abort controllers so the renderer can cancel an in-flight stream. */
const streamAbortControllers = new Map<string, AbortController>();
/** Workspace id for each active stream (used by settings window leave guards). */
const streamWorkspaceByConversationId = new Map<string, string | null>();

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

export function beginChatStream(conversationId: string, workspaceId: string | null): AbortController {
  streamAbortControllers.get(conversationId)?.abort();
  const abortController = new AbortController();
  streamAbortControllers.set(conversationId, abortController);
  streamWorkspaceByConversationId.set(conversationId, workspaceId);
  return abortController;
}

export function endChatStream(conversationId: string): void {
  streamAbortControllers.delete(conversationId);
  streamWorkspaceByConversationId.delete(conversationId);
}

export async function abortChatStream(conversationId: string): Promise<{ ok: boolean; error?: string }> {
  const controller = streamAbortControllers.get(conversationId);
  if (controller) {
    controller.abort();
    streamAbortControllers.delete(conversationId);
    streamWorkspaceByConversationId.delete(conversationId);
    try {
      await pythonControlFetch('/chat/abort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: conversationId }),
      });
    } catch {
      // Best-effort: Python abort may fail if stream already ended.
    }
    return { ok: true };
  }
  return { ok: false, error: 'No active stream' };
}
