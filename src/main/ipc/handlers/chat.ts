import { ipcMain } from 'electron';
import type { LlmStatusPayload, TurnEditedFile } from '../../../shared';
import { pythonControlFetch, pythonLongFetch, pythonSsePost } from '../../python/http-client';
import { ensurePythonReady } from '../../python/server';
import {
  assertTrustedAppRenderer,
  assertTrustedMainRenderer,
  assertTrustedMainRendererOrThrow,
  isTrustedMainRenderer,
} from '../assert-trusted-renderer';
import { mainState } from '../../state';
import { createSettingsWindow, notifySettingsRendererReady, parseSettingsWindowTab } from '../../windows/settings-window';
import { finalizeTurnEdits } from '../../turn-edits';
import { sendParsedPayload } from './chat-stream-payload';
import {
  abortChatStream,
  beginChatStream,
  endChatStream,
  getPendingStreamIdsForWorkspace,
  wasChatStreamSuperseded,
} from './chat-stream-state';
import { workspacePathForWorkspaceId } from './conversation-timeline';

export { parseStreamPayload, sendParsedPayload } from './chat-stream-payload';

export type ChatStreamOutcome = 'completed' | 'aborted' | 'error';

/** Turn identity needed to snapshot the turn's edited files when the stream ends. */
interface ChatTurnRef {
  userMessageId: string;
  workspaceId: string | null;
}

/**
 * Snapshot the turn's edited files (journal "before" vs disk "after"), then signal done with
 * the summary so the renderer can attach it to the assistant message it creates.
 */
async function finalizeTurnEditsSafe(conversationId: string, turn: ChatTurnRef): Promise<TurnEditedFile[]> {
  const root = workspacePathForWorkspaceId(turn.workspaceId);
  if (!turn.userMessageId || !root) {
    return [];
  }
  try {
    return await finalizeTurnEdits(conversationId, turn.userMessageId, root);
  } catch (err) {
    console.error('[Chat] finalizeTurnEdits failed:', err);
    return [];
  }
}

async function replyMessageDone(
  event: Electron.IpcMainEvent,
  conversationId: string,
  outcome: ChatStreamOutcome,
  turn: ChatTurnRef,
): Promise<void> {
  const editedFiles = await finalizeTurnEditsSafe(conversationId, turn);
  event.reply('message-done', conversationId, outcome, editedFiles);
}

function workspaceNotesFromIpc(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((n): n is string => typeof n === 'string' && n.trim().length > 0).map((n) => n.trim());
}

/**
 * - `ready` — renderer finished boot (log only).
 * - `open-settings-window` / `close-settings-window` / `settings-window-ready` — settings BrowserWindow.
 * - `message` — POST to Python `/chat/stream`, forward SSE lines to `message-chunk` / `message-done` / `message-status`.
 */
export function registerChatIpc(): void {
  ipcMain.on('ready', (event) => {
    if (!isTrustedMainRenderer(event.sender)) {
      return;
    }
    console.log('Renderer is ready');
  });

  ipcMain.on('open-settings-window', (event, tab?: unknown) => {
    if (!isTrustedMainRenderer(event.sender)) {
      return;
    }
    createSettingsWindow(parseSettingsWindowTab(tab));
  });

  ipcMain.on('close-settings-window', (event) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return;
    }
    const sw = mainState.settingsWindow;
    if (sw && !sw.isDestroyed()) {
      sw.close();
    }
  });

  ipcMain.on('settings-window-ready', (event) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return;
    }
    notifySettingsRendererReady(event.sender);
  });

  ipcMain.on(
    'message',
    async (
      event,
      conversationId: string,
      msg: string,
      applyMode = true,
      autoApplyMode = false,
      structuredContent?: unknown,
      workspaceId?: string | null,
      composerMode = 'agent',
      speechEnabled = false,
      ttsProvider = 'kokoro',
      userMessageId = '',
      adminElevationGranted = false,
      workspaceNotes: unknown = [],
    ) => {
      if (!isTrustedMainRenderer(event.sender)) {
        return;
      }
      console.log('Received message for', conversationId, ':', msg);

      const abortController = beginChatStream(conversationId, workspaceId ?? null);
      const turn: ChatTurnRef = {
        userMessageId: typeof userMessageId === 'string' ? userMessageId.trim() : '',
        workspaceId: workspaceId ?? null,
      };

      const body: Record<string, unknown> = {
        session_id: conversationId,
        message: msg,
        apply_mode: applyMode,
        auto_apply_mode: autoApplyMode,
        admin_elevation_granted: !!adminElevationGranted,
        composer_mode: composerMode,
        speech_enabled: !!speechEnabled,
        tts_provider: ttsProvider === 'openai-compatible' ? 'openai-compatible' : 'kokoro',
      };
      if (typeof userMessageId === 'string' && userMessageId.trim()) {
        body.user_message_id = userMessageId.trim();
      }
      const notes = workspaceNotesFromIpc(workspaceNotes);
      if (notes.length > 0) {
        body.workspace_notes = notes;
      }
      if (Array.isArray(structuredContent) && structuredContent.length > 0) {
        const ok = structuredContent.every((p) => p !== null && typeof p === 'object' && !Array.isArray(p));
        if (ok) {
          body.structuredContent = structuredContent;
        } else {
          console.warn('[Chat] Ignoring structuredContent: expected array of objects');
        }
      }

      try {
        const res = await pythonSsePost('/chat/stream', body, abortController.signal);

        if (!res.ok || !res.body) {
          throw new Error(`Stream request failed: ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6);
            if (payload === '[DONE]') {
              await replyMessageDone(event, conversationId, 'completed', turn);
            } else {
              sendParsedPayload(event, conversationId, payload);
            }
          }
        }

        if (buffer.startsWith('data: ')) {
          const payload = buffer.slice(6);
          if (payload === '[DONE]') {
            await replyMessageDone(event, conversationId, 'completed', turn);
          } else if (payload) {
            sendParsedPayload(event, conversationId, payload);
            await replyMessageDone(event, conversationId, 'completed', turn);
          }
        }
      } catch (err) {
        if (abortController.signal.aborted) {
          if (wasChatStreamSuperseded(abortController)) {
            // A newer message for this conversation replaced this stream; the renderer already
            // shows that turn, so only settle this turn's edits and stay silent.
            console.log('Stream superseded for', conversationId);
            await finalizeTurnEditsSafe(conversationId, turn);
            return;
          }
          console.log('Stream aborted for', conversationId);
          await replyMessageDone(event, conversationId, 'aborted', turn);
          return;
        }
        console.error('Failed to reach Python server:', err);
        event.reply('message-status', conversationId, {
          id: 'fatal',
          label: 'Backend request failed',
          detail: 'Clara could not reach the LangChain backend.',
          state: 'error',
          source: 'agent',
        } as LlmStatusPayload);
        event.reply('message-chunk', conversationId, 'Error: could not reach the AI backend.');
        await replyMessageDone(event, conversationId, 'error', turn);
      } finally {
        endChatStream(conversationId, abortController);
      }
    },
  );

  ipcMain.handle(
    'agent-continue',
    async (
      event,
      conversationId: string,
      note: string,
      deleteAction?: 'confirm' | 'cancel',
      deleteRequestId?: string,
      acceptCommandAction?: 'confirm' | 'confirm_session' | 'cancel' | 'deny',
      acceptCommandRequestId?: string,
      planConfirmAction?: 'confirm' | 'cancel',
      planConfirmRequestId?: string,
    ) => {
      try {
        assertTrustedMainRendererOrThrow(event);
      } catch {
        return { ok: false, error: 'Untrusted IPC sender' };
      }
      try {
        const res = await pythonControlFetch('/chat/agent-continue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: conversationId,
            note: note ?? '',
            delete_action: deleteAction ?? null,
            delete_request_id: deleteRequestId ?? '',
            accept_command_action: acceptCommandAction ?? null,
            accept_command_request_id: acceptCommandRequestId ?? '',
            plan_confirm_action: planConfirmAction ?? null,
            plan_confirm_request_id: planConfirmRequestId ?? '',
          }),
        });
        if (!res.ok) {
          const text = await res.text();
          return { ok: false, error: text || `HTTP ${res.status}` };
        }
        const data = (await res.json()) as { ok?: boolean; batchComplete?: boolean; detail?: string };
        if (data.ok === false && data.detail) {
          // e.g. a stale answer for a card that is no longer waiting.
          return { ok: false, batchComplete: data.batchComplete !== false, error: data.detail };
        }
        return { ok: data.ok !== false, batchComplete: data.batchComplete !== false };
      } catch (err) {
        console.error('agent-continue failed:', err);
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle('abort-message', async (event, conversationId: string) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      return { ok: false as const, error: 'Untrusted IPC sender' };
    }
    return abortChatStream(conversationId);
  });

  ipcMain.handle(
    'background-command-terminal-closed',
    async (event, conversationId: string, commandId: string) => {
      try {
        assertTrustedMainRendererOrThrow(event);
      } catch {
        return { ok: false, error: 'Untrusted IPC sender' };
      }
      try {
        const res = await pythonControlFetch('/chat/background-command-terminal-closed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: conversationId,
            command_id: commandId ?? '',
          }),
        });
        if (!res.ok) {
          const text = await res.text();
          return { ok: false, error: text || `HTTP ${res.status}` };
        }
        const data = (await res.json()) as { ok?: boolean; detail?: string };
        return { ok: data.ok !== false, detail: data.detail ?? '' };
      } catch (err) {
        console.error('background-command-terminal-closed failed:', err);
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle(
    'agent-question-answers',
    async (
      event,
      conversationId: string,
      action: 'submit' | 'cancel',
      requestId: string,
      answers: { questionId: string; optionId?: string; otherText?: string }[] = [],
    ) => {
      try {
        assertTrustedMainRendererOrThrow(event);
      } catch {
        return { ok: false, error: 'Untrusted IPC sender' };
      }
      try {
        const res = await pythonControlFetch('/chat/agent-question-answers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: conversationId,
            request_id: requestId ?? '',
            action: action ?? 'submit',
            answers: (answers ?? []).map((a) => ({
              question_id: a.questionId ?? '',
              option_id: a.optionId ?? '',
              other_text: a.otherText ?? '',
            })),
          }),
        });
        if (!res.ok) {
          const text = await res.text();
          return { ok: false, error: text || `HTTP ${res.status}` };
        }
        const data = (await res.json()) as { ok?: boolean };
        return { ok: data.ok !== false };
      } catch (err) {
        console.error('agent-question-answers failed:', err);
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle('build-plan-cancel', async (event, conversationId: string, planId: string) => {
    try {
      assertTrustedMainRendererOrThrow(event);
    } catch {
      return { ok: false, error: 'Untrusted IPC sender' };
    }
    try {
      const res = await pythonControlFetch('/build-plan/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: conversationId, plan_id: planId ?? '' }),
      });
      if (!res.ok) {
        const text = await res.text();
        return { ok: false, error: text || `HTTP ${res.status}` };
      }
      const data = (await res.json()) as { ok?: boolean };
      return { ok: data.ok !== false };
    } catch (err) {
      console.error('build-plan-cancel failed:', err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('get-pending-stream-ids-for-workspace', (event, workspaceId: string | null) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      return [];
    }
    return getPendingStreamIdsForWorkspace(workspaceId);
  });

  ipcMain.handle('abort-pending-streams-for-workspace', async (event, workspaceId: string | null) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      return { aborted: [] as string[] };
    }
    const ids = getPendingStreamIdsForWorkspace(workspaceId);
    const aborted: string[] = [];
    for (const id of ids) {
      const result = await abortChatStream(id);
      if (result.ok) {
        aborted.push(id);
      }
    }
    return { aborted };
  });

  ipcMain.handle('sync-auto-apply-mode', async (event, conversationId: string, autoApplyMode: boolean) => {
    try {
      assertTrustedMainRendererOrThrow(event);
    } catch {
      return { ok: false, error: 'Untrusted IPC sender' };
    }
    try {
      await ensurePythonReady();
      const res = await pythonControlFetch('/session/auto-apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: conversationId, auto_apply_mode: !!autoApplyMode }),
      });
      if (!res.ok) {
        const text = await res.text();
        return { ok: false, error: text || `HTTP ${res.status}` };
      }
      return { ok: true };
    } catch (err) {
      console.error('sync-auto-apply-mode failed:', err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('sync-admin-elevation', async (event, conversationId: string, granted: boolean) => {
    try {
      assertTrustedMainRendererOrThrow(event);
    } catch {
      return { ok: false, error: 'Untrusted IPC sender' };
    }
    try {
      await ensurePythonReady();
      const res = await pythonLongFetch('/session/admin-elevation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: conversationId, granted: !!granted }),
      });
      const text = await res.text();
      let body: { ok?: boolean; granted?: boolean; error?: string } = {};
      if (text) {
        try {
          body = JSON.parse(text) as { ok?: boolean; granted?: boolean; error?: string };
        } catch {
          body = {};
        }
      }
      if (!res.ok || body.ok === false) {
        return { ok: false, error: body.error || text || `HTTP ${res.status}` };
      }
      return { ok: true };
    } catch (err) {
      console.error('sync-admin-elevation failed:', err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
