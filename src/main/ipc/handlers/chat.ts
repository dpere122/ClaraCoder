import { ipcMain } from 'electron';
import type {
  LlmStatusPayload,
} from '../../../shared';
import { parseAgentStreamPayload } from '../../../shared';
import { PYTHON_URL } from '../../python/server';
import { mainState } from '../../state';

/** Per-conversation abort controllers so the renderer can cancel an in-flight stream. */
const streamAbortControllers = new Map<string, AbortController>();

export const parseStreamPayload = parseAgentStreamPayload;

export function sendParsedPayload(event: Electron.IpcMainEvent, conversationId: string, payload: string): void {
  const parsed = parseStreamPayload(payload);
  if (parsed.type === 'status') {
    event.reply('message-status', conversationId, parsed.status);
  } else if (parsed.type === 'planner') {
    event.reply('message-planner', conversationId, parsed.planner);
  } else if (parsed.type === 'diff') {
    event.reply('message-diff', conversationId, parsed.diff);
  } else if (parsed.type === 'accept_command') {
    event.reply('message-accept-command', conversationId, parsed.acceptCommand);
  } else if (parsed.type === 'copy_confirm') {
    event.reply('message-copy-confirm', conversationId, parsed.copyConfirm);
  } else if (parsed.type === 'delete_confirm') {
    event.reply('message-delete-confirm', conversationId, parsed.deleteConfirm);
  } else if (parsed.type === 'tool_read_chunk') {
    event.reply('message-tool-read-chunk', conversationId, parsed.delta);
  } else if (parsed.type === 'tool_exec_chunk') {
    event.reply('message-tool-exec-chunk', conversationId, parsed.delta, parsed.streamTag, parsed.label);
  } else if (parsed.type === 'tool_exec_complete') {
    event.reply(
      'message-tool-exec-complete',
      conversationId,
      parsed.streamTag,
      parsed.label,
      parsed.exitCode,
      parsed.outputExcerpt,
    );
  } else if (parsed.type === 'chunk') {
    event.reply('message-chunk', conversationId, parsed.delta, parsed.streamTag);
  }
}

/**
 * - `ready` — renderer finished boot (log only).
 * - `close-settings-window` — closes the modal settings BrowserWindow.
 * - `message` — POST to Python `/chat/stream`, forward SSE lines to `message-chunk` / `message-done` / `message-status`.
 */
export function registerChatIpc(): void {
  ipcMain.on('ready', () => {
    console.log('Renderer is ready');
  });

  ipcMain.on('close-settings-window', () => {
    const sw = mainState.settingsWindow;
    if (sw && !sw.isDestroyed()) {
      sw.close();
    }
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
    ) => {
    console.log('Received message for', conversationId, ':', msg);

    // Cancel any previous in-flight stream for this conversation.
    streamAbortControllers.get(conversationId)?.abort();
    const abortController = new AbortController();
    streamAbortControllers.set(conversationId, abortController);

    const body: Record<string, unknown> = {
      session_id: conversationId,
      message: msg,
      apply_mode: applyMode,
      auto_apply_mode: autoApplyMode,
    };
    if (Array.isArray(structuredContent) && structuredContent.length > 0) {
      const ok = structuredContent.every((p) => p !== null && typeof p === 'object' && !Array.isArray(p));
      if (ok) {
        body.structuredContent = structuredContent;
      } else {
        console.warn('[Chat] Ignoring structuredContent: expected array of objects');
      }
    }

    try {
      const res = await fetch(`${PYTHON_URL}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: abortController.signal,
      });

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
            event.reply('message-done', conversationId);
          } else {
            sendParsedPayload(event, conversationId, payload);
          }
        }
      }

      if (buffer.startsWith('data: ')) {
        const payload = buffer.slice(6);
        if (payload === '[DONE]') {
          event.reply('message-done', conversationId);
        } else if (payload) {
          sendParsedPayload(event, conversationId, payload);
          event.reply('message-done', conversationId);
        }
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        console.log('Stream aborted for', conversationId);
        event.reply('message-done', conversationId);
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
      event.reply('message-done', conversationId);
    } finally {
      streamAbortControllers.delete(conversationId);
    }
  });

  ipcMain.handle(
    'agent-continue',
    async (
      _event,
      conversationId: string,
      note: string,
      deleteAction?: 'confirm' | 'cancel',
      deleteRequestId?: string,
      copyAction?: 'confirm' | 'cancel',
      copyRequestId?: string,
      acceptCommandAction?: 'confirm' | 'cancel',
      acceptCommandRequestId?: string,
      stagedTransferAction?: 'confirm' | 're_review',
    ) => {
    try {
      const res = await fetch(`${PYTHON_URL}/chat/agent-continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: conversationId,
          note: note ?? '',
          delete_action: deleteAction ?? null,
          delete_request_id: deleteRequestId ?? '',
          copy_action: copyAction ?? null,
          copy_request_id: copyRequestId ?? '',
          accept_command_action: acceptCommandAction ?? null,
          accept_command_request_id: acceptCommandRequestId ?? '',
          staged_transfer_action: stagedTransferAction ?? null,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        return { ok: false, error: text || `HTTP ${res.status}` };
      }
      return { ok: true };
    } catch (err) {
      console.error('agent-continue failed:', err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('abort-message', async (_event, conversationId: string) => {
    const controller = streamAbortControllers.get(conversationId);
    if (controller) {
      controller.abort();
      streamAbortControllers.delete(conversationId);
      try {
        await fetch(`${PYTHON_URL}/chat/abort`, {
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
  });

  ipcMain.handle('sync-auto-apply-mode', async (_event, conversationId: string, autoApplyMode: boolean) => {
    try {
      const res = await fetch(`${PYTHON_URL}/session/auto-apply`, {
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
}
