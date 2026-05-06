import { protocol } from 'electron';
import { PassThrough } from 'stream';
import { randomUUID } from 'crypto';
import { mainState } from '../state';
import { PYTHON_URL } from '../python/server';

/**
 * Registers `registerStreamProtocol('nemo-tts')` to stream WAV from Python `/tts` into `<audio>`.
 */
export function registerNemoTtsStreamProtocol(): void {
  protocol.registerStreamProtocol('nemo-tts', (request, callback) => {
    let pathName: string;
    try {
      pathName = new URL(request.url).pathname;
    } catch {
      callback({ error: -2 });
      return;
    }
    const segments = pathName.split('/').filter(Boolean);
    const id = segments[segments.length - 1];
    if (!id) {
      callback({ error: -6 });
      return;
    }
    const entry = mainState.ttsStreamTokens.get(id);
    if (!entry) {
      callback({ error: -6 });
      return;
    }
    mainState.ttsStreamTokens.delete(id);

    mainState.ttsAbort?.abort();
    mainState.ttsAbort = new AbortController();
    const signal = mainState.ttsAbort.signal;

    const pass = new PassThrough();
    callback({
      statusCode: 200,
      headers: {
        'Content-Type': 'audio/wav',
        'Cache-Control': 'no-store',
      },
      data: pass,
    });

    void (async () => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      try {
        const res = await fetch(`${PYTHON_URL}/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: entry.text, voice: entry.voice, speed: entry.speed }),
          signal,
        });
        if (!res.ok || !res.body) {
          pass.destroy();
          return;
        }
        reader = res.body.getReader();
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          if (signal.aborted) break;
          if (!value?.byteLength) continue;
          const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
          if (!pass.write(buf)) {
            await new Promise<void>((r) => pass.once('drain', r));
          }
        }
        pass.end();
      } catch {
        try {
          pass.destroy();
        } catch {
          // ignore
        }
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
  });
}

/** `tts-stream-register` stores text/voice/speed under this id for the next `nemo-tts://` fetch. */
export function registerTtsStreamToken(text: string, voice: string, speed: number): string {
  const id = randomUUID();
  mainState.ttsStreamTokens.set(id, { text, voice, speed });
  return id;
}
