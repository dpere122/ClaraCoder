import { ipcMain } from 'electron';
import type { LlmStatusPayload } from '../../../shared';
import { PYTHON_URL } from '../../python/server';
import { mainState } from '../../state';

/**
 * Parse NDJSON/SSE-style payloads from Python: either `{ type, delta }` text chunks or `{ type, status }` rows.
 */
export function parseStreamPayload(
  payload: string,
): { type: 'chunk'; delta: string } | { type: 'status'; status: LlmStatusPayload } {
  try {
    const parsed = JSON.parse(payload) as {
      type?: string;
      delta?: string;
      text?: string;
      status?: LlmStatusPayload;
    };
    if (parsed.type === 'status' && parsed.status) {
      return {
        type: 'status',
        status: {
          id: parsed.status.id,
          label: parsed.status.label,
          detail: parsed.status.detail ?? '',
          state: parsed.status.state ?? 'running',
          source: parsed.status.source ?? 'agent',
        },
      };
    }

    if (parsed.type === 'chunk' && typeof parsed.delta === 'string') {
      return { type: 'chunk', delta: parsed.delta };
    }
  } catch {
    // fall through to plain text chunks
  }

  return { type: 'chunk', delta: payload };
}

export function sendParsedPayload(event: Electron.IpcMainEvent, conversationId: string, payload: string): void {
  const parsed = parseStreamPayload(payload);
  if (parsed.type === 'status') {
    event.reply('message-status', conversationId, parsed.status);
  } else {
    event.reply('message-chunk', conversationId, parsed.delta);
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

  ipcMain.on('message', async (event, conversationId: string, msg: string, _applyModeArg?: boolean) => {
    console.log('Received message for', conversationId, ':', msg);
    try {
      const res = await fetch(`${PYTHON_URL}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: conversationId, message: msg, apply_mode: true }),
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
    }
  });
}
