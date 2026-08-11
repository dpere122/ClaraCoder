import { ipcMain } from 'electron';
import { assertTrustedMainRenderer, assertTrustedMainRendererOrThrow } from '../assert-trusted-renderer';
import { abortAllTtsStreamControllers, mainState } from '../../state';
import { loadConfig } from '../../config/load-save';
import { PYTHON_URL } from '../../python/server';
import { registerTtsStreamToken } from '../../protocol/nemo-tts';
import { streamTtsResponseToIpcPackets } from '../../tts/stream-response-to-packets';
import { fetchTtsResponse } from '../../tts/fetch';

function ipcAudioPayloadToBuffer(payload: unknown): Buffer {
  if (Buffer.isBuffer(payload)) {
    return payload;
  }
  if (payload instanceof ArrayBuffer) {
    return Buffer.from(payload);
  }
  if (payload != null && ArrayBuffer.isView(payload)) {
    const view = payload as ArrayBufferView;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  }
  throw new Error('Invalid audio payload from renderer');
}

/**
 * - `transcribe` — POST WAV bytes to Python `/transcribe`.
 * - `tts-stream-start` / `abort` — stream WAV chunks over IPC (`tts-stream-packet`).
 * - `tts-stream-register` — reserve a `nemo-tts://` URL backed by protocol handler.
 */
export function registerAudioTtsIpc(): void {
  ipcMain.handle('transcribe', async (event, payload: unknown) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      throw new Error('Untrusted IPC sender');
    }
    const audio = ipcAudioPayloadToBuffer(payload);
    if (audio.length < 100) {
      throw new Error('Recording was too short or empty; check microphone input.');
    }
    const res = await fetch(`${PYTHON_URL}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: audio,
    });
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new Error(`Transcription service returned non-JSON (${res.status})`);
    }
    if (!res.ok) {
      const detail =
        data &&
        typeof data === 'object' &&
        'detail' in data &&
        (typeof (data as { detail: unknown }).detail === 'string' ||
          typeof (data as { detail: unknown }).detail === 'number')
          ? String((data as { detail: string | number }).detail)
          : res.statusText || `HTTP ${res.status}`;
      throw new Error(detail);
    }
    const text =
      data && typeof data === 'object' && 'text' in data && typeof (data as { text: unknown }).text === 'string'
        ? (data as { text: string }).text
        : '';
    return text;
  });

  ipcMain.handle('tts-stream-abort', (event) => {
    try {
      assertTrustedMainRendererOrThrow(event);
    } catch {
      return { ok: false, error: 'Untrusted IPC sender' };
    }
    abortAllTtsStreamControllers();
    return { ok: true };
  });

  ipcMain.handle(
    'tts-stream-start',
    async (
      event,
      payload: { text: string; voice: string; speed: number; seq: number; instructions?: string },
    ) => {
      try {
        assertTrustedMainRendererOrThrow(event);
      } catch {
        return { ok: false, error: 'Untrusted IPC sender' };
      }
      const { text, voice, speed, seq, instructions } = payload;
      const key = `ipc:${seq}`;
      const ac = new AbortController();
      mainState.ttsStreamControllers.set(key, ac);
      const signal = ac.signal;
      const wc = event.sender;

      void (async () => {
        try {
          const config = await loadConfig();
          const res = await fetchTtsResponse(
            config.audioTranscription,
            { text, voice, speed, instructions },
            signal,
          );
          await streamTtsResponseToIpcPackets(res, wc, seq, signal);
        } catch (e: unknown) {
          if (signal.aborted) {
            try {
              wc.send('tts-stream-packet', { kind: 'end', seq });
            } catch {
              // ignore
            }
            return;
          }
          const message = e instanceof Error ? e.message : String(e);
          wc.send('tts-stream-packet', { kind: 'error', seq, message });
        } finally {
          if (mainState.ttsStreamControllers.get(key) === ac) {
            mainState.ttsStreamControllers.delete(key);
          }
        }
      })();

      return { ok: true };
    },
  );

  ipcMain.handle(
    'tts-stream-register',
    (event, payload: { text: string; voice: string; speed: number; instructions?: string }) => {
      try {
        assertTrustedMainRenderer(event);
      } catch {
        return { url: '' };
      }
      const id = registerTtsStreamToken(payload.text, payload.voice, payload.speed, payload.instructions);
      return { url: `nemo-tts://electron/stream/${id}` };
    },
  );
}
