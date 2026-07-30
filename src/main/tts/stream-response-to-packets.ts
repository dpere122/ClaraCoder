import type { WebContents } from 'electron';
import { PassThrough } from 'stream';

/** Stream a TTS HTTP response body to renderer IPC packets. */
export async function streamTtsResponseToIpcPackets(
  res: Response,
  wc: WebContents,
  seq: number,
  signal: AbortSignal,
): Promise<void> {
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

  const reader = res.body.getReader();
  let sentTerminal = false;
  try {
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
    wc.send('tts-stream-packet', { kind: 'end', seq });
    sentTerminal = true;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
    // Always emit a terminal packet so renderer collectors resolve after abort.
    if (!sentTerminal) {
      try {
        wc.send('tts-stream-packet', { kind: 'end', seq });
      } catch {
        // ignore
      }
    }
  }
}

/** Pipe a TTS HTTP response body into a Node stream (``nemo-tts://`` protocol). */
export async function streamTtsResponseToPassThrough(
  res: Response,
  pass: PassThrough,
  signal: AbortSignal,
): Promise<void> {
  if (!res.ok || !res.body) {
    pass.destroy();
    return;
  }

  const reader = res.body.getReader();
  try {
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
      await reader.cancel();
    } catch {
      // ignore
    }
  }
}
