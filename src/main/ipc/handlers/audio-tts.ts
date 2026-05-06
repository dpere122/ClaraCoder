import { ipcMain } from 'electron';
import { mainState } from '../../state';
import { PYTHON_URL } from '../../python/server';
import { registerTtsStreamToken } from '../../protocol/nemo-tts';

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
  ipcMain.handle('transcribe', async (_event, payload: unknown) => {
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

  ipcMain.handle('tts-stream-abort', () => {
    mainState.ttsAbort?.abort();
    mainState.ttsAbort = null;
    return { ok: true };
  });

  ipcMain.handle('tts-stream-start', async (event, payload: { text: string; voice: string; speed: number; seq: number }) => {
    const { text, voice, speed, seq } = payload;
    mainState.ttsAbort?.abort();
    mainState.ttsAbort = new AbortController();
    const signal = mainState.ttsAbort.signal;
    const wc = event.sender;

    void (async () => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      try {
        const res = await fetch(`${PYTHON_URL}/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voice, speed }),
          signal,
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          wc.send('tts-stream-packet', {
            kind: 'error',
            seq,
            message: `TTS HTTP ${res.status}: ${detail.slice(0, 240)}`,
          });
          return;
        }
        if (!res.body) {
          wc.send('tts-stream-packet', { kind: 'error', seq, message: 'TTS: empty response body' });
          return;
        }
        reader = res.body.getReader();
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          if (signal.aborted) break;
          if (!value?.byteLength) continue;
          wc.send('tts-stream-packet', {
            kind: 'chunk',
            seq,
            data: Buffer.from(value.buffer, value.byteOffset, value.byteLength),
          });
        }
        if (!signal.aborted) {
          wc.send('tts-stream-packet', { kind: 'end', seq });
        }
      } catch (e: unknown) {
        if (signal.aborted) return;
        const message = e instanceof Error ? e.message : String(e);
        wc.send('tts-stream-packet', { kind: 'error', seq, message });
      } finally {
        try {
          await reader?.cancel();
        } catch {
          // ignore
        }
        if (mainState.ttsAbort?.signal === signal) {
          mainState.ttsAbort = null;
        }
      }
    })();

    return { ok: true };
  });

  ipcMain.handle('tts-stream-register', (_event, payload: { text: string; voice: string; speed: number }) => {
    const id = registerTtsStreamToken(payload.text, payload.voice, payload.speed);
    return { url: `nemo-tts://electron/stream/${id}` };
  });
}
