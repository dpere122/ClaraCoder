import { protocol } from 'electron';
import { PassThrough } from 'stream';
import { randomUUID } from 'crypto';
import { abortAllTtsStreamControllers, mainState } from '../state';
import { loadConfig } from '../config/load-save';
import { streamTtsResponseToPassThrough } from '../tts/stream-response-to-packets';
import { fetchTtsResponse } from '../tts/fetch';

/**
 * Registers `registerStreamProtocol('nemo-tts')` to stream WAV from the configured TTS backend.
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

    abortAllTtsStreamControllers();
    const protoKey = `proto:${id}`;
    const ac = new AbortController();
    mainState.ttsStreamControllers.set(protoKey, ac);
    const signal = ac.signal;

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
      try {
        const config = await loadConfig();
        const res = await fetchTtsResponse(
          config.audioTranscription,
          {
            text: entry.text,
            voice: entry.voice,
            speed: entry.speed,
            instructions: entry.instructions,
          },
          signal,
        );
        await streamTtsResponseToPassThrough(res, pass, signal);
      } catch {
        try {
          pass.destroy();
        } catch {
          // ignore
        }
      } finally {
        if (mainState.ttsStreamControllers.get(protoKey) === ac) {
          mainState.ttsStreamControllers.delete(protoKey);
        }
      }
    })();
  });
}

/** `tts-stream-register` stores text/voice/speed under this id for the next `nemo-tts://` fetch. */
export function registerTtsStreamToken(
  text: string,
  voice: string,
  speed: number,
  instructions?: string,
): string {
  const id = randomUUID();
  mainState.ttsStreamTokens.set(id, { text, voice, speed, instructions });
  return id;
}
