/**
 * Edge-style TTS playback: Python MP3 via main process, MSE when supported, else `nemo-tts://` + `<audio>`.
 * Owns generation tokens so overlapping replies / toggle-off cancel in-flight work safely.
 */
import { Injectable, NgZone, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import { ElectronService } from './electron.service';

@Injectable({ providedIn: 'root' })
export class TtsPlaybackService {
  private static readonly TTS_CHUNK_MAX = 880;

  /** Shown on the latest assistant bubble while the first chunk is in flight. */
  readonly ttsLoading = signal(false);

  private speechGen = 0;
  private ttsStreamSeq = 0;
  private currentAudio: HTMLAudioElement | null = null;
  /** True after we paused assistant TTS because talk mode picked up voice; cleared after capture ends. */
  private ttsPausedForTalk = false;

  constructor(
    private readonly electron: ElectronService,
    private readonly zone: NgZone,
  ) {}

  getCurrentAudio(): HTMLAudioElement | null {
    return this.currentAudio;
  }

  /** Bump generation, stop playback, clear TTS loading UI (e.g. speech toggled off). */
  invalidateSpeechPipeline(): void {
    this.speechGen++;
    this.electron.abortTtsStream();
    this.stopSpeech();
    this.zone.run(() => this.ttsLoading.set(false));
  }

  private splitTextForTts(text: string): string[] {
    const max = TtsPlaybackService.TTS_CHUNK_MAX;
    if (text.length <= max) return [text];
    const out: string[] = [];
    let rest = text;
    while (rest.length > max) {
      let cut = rest.lastIndexOf('. ', max);
      if (cut < max * 0.35) cut = rest.lastIndexOf('? ', max);
      if (cut < max * 0.35) cut = rest.lastIndexOf('! ', max);
      if (cut < max * 0.35) cut = rest.lastIndexOf('\n', max);
      if (cut < max * 0.35) cut = max;
      const piece = rest.slice(0, cut + 1).trim();
      if (piece) out.push(piece);
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) out.push(rest);
    return out.length > 0 ? out : [text];
  }

  async speakText(text: string, voice: string): Promise<void> {
    this.invalidateSpeechPipeline();
    const gen = this.speechGen;
    const clean = text
      .replace(/<details class="llm-reasoning"[\s\S]*?<\/details>/gi, '')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`]+`/g, '')
      .replace(/#{1,6}\s+/g, '')
      .replace(/[*_~]{1,3}/g, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu, '')
      .replace(/\n{2,}/g, '\n')
      .trim();
    if (!clean) return;
    const chunks = this.splitTextForTts(clean);
    this.zone.run(() => this.ttsLoading.set(true));
    try {
      for (let i = 0; i < chunks.length; i++) {
        if (gen !== this.speechGen) return;
        const seq = ++this.ttsStreamSeq;
        await this.playTtsStreamChunk(chunks[i], voice, seq, gen, () => {
          if (i === 0) this.zone.run(() => this.ttsLoading.set(false));
        });
      }
    } catch (err) {
      console.error('Edge TTS failed:', err);
    } finally {
      if (this.speechGen === gen) {
        this.zone.run(() => this.ttsLoading.set(false));
      }
    }
  }

  private mergeUint8Arrays(parts: Uint8Array[]): Uint8Array {
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  /** Progressive MP3 via Electron `nemo-tts://` custom stream protocol (no MSE). */
  private async playTtsViaStreamProtocol(
    text: string,
    voice: string,
    gen: number,
    onFirstChunk: () => void,
  ): Promise<void> {
    if (gen !== this.speechGen) return;
    const { url } = await this.electron.registerTtsStreamUrl(text, voice);
    if (!url || gen !== this.speechGen) return;

    return new Promise((resolve) => {
      const audio = new Audio(url);
      this.currentAudio = audio;
      let reportedFirst = false;
      const markFirst = (): void => {
        if (reportedFirst) return;
        reportedFirst = true;
        onFirstChunk();
      };
      audio.addEventListener('loadeddata', markFirst);
      audio.addEventListener('playing', markFirst);

      const done = (): void => {
        audio.removeEventListener('ended', done);
        audio.removeEventListener('error', onErr);
        audio.removeEventListener('loadeddata', markFirst);
        audio.removeEventListener('playing', markFirst);
        if (this.currentAudio === audio) this.currentAudio = null;
        resolve();
      };
      const onErr = (): void => {
        console.warn('[TTS] Stream URL playback error (nemo-tts://).');
        done();
      };
      audio.addEventListener('ended', done);
      audio.addEventListener('error', onErr);
      void audio.play().catch((err) => {
        console.warn('[TTS] audio.play() failed for stream URL.', err);
        done();
      });
    });
  }

  private waitSourceBuffer(sb: SourceBuffer): Promise<void> {
    return new Promise((resolve) => {
      if (!sb.updating) {
        resolve();
        return;
      }
      sb.addEventListener('updateend', () => resolve(), { once: true });
    });
  }

  private async playAudioBufferFromUint8(data: Uint8Array, gen: number): Promise<void> {
    if (data.byteLength === 0) return;
    return new Promise((resolve) => {
      if (gen !== this.speechGen) {
        resolve();
        return;
      }
      const blob = new Blob([new Uint8Array(data)], { type: 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      this.currentAudio = audio;
      const done = (): void => {
        URL.revokeObjectURL(url);
        if (this.currentAudio === audio) this.currentAudio = null;
        resolve();
      };
      audio.onended = done;
      audio.onerror = done;
      void audio.play().catch(() => done());
    });
  }

  /**
   * Pulls MP3 from Python via the main process: MSE when Chromium allows MP3 there, otherwise
   * `nemo-tts://` stream protocol + `<audio>` (progressive decode — typical on desktop Electron).
   */
  private playTtsStreamChunk(
    text: string,
    voice: string,
    seq: number,
    gen: number,
    onFirstChunk: () => void,
  ): Promise<void> {
    if (gen !== this.speechGen) return Promise.resolve();

    const MIME = 'audio/mpeg; codecs="mp3"';
    const useMse =
      typeof MediaSource !== 'undefined' &&
      typeof MediaSource.isTypeSupported === 'function' &&
      MediaSource.isTypeSupported(MIME);

    if (!useMse) {
      return this.playTtsViaStreamProtocol(text, voice, gen, onFirstChunk);
    }

    return new Promise((resolve, reject) => {
      let useMseInner = true;
      const collected: Uint8Array[] = [];
      let firstChunkSeen = false;
      let completed = false;
      let streamComplete = false;
      let sourceIsOpen = false;

      let mediaSource: MediaSource | null = null;
      let objectUrl: string | null = null;
      let audio: HTMLAudioElement | null = null;
      let sourceBuffer: SourceBuffer | null = null;
      const pendingAppend: Uint8Array[] = [];
      let pumpTail: Promise<void> = Promise.resolve();

      let sub: Subscription;

      const cleanup = (): void => {
        try {
          if (mediaSource?.readyState === 'open') {
            mediaSource.endOfStream();
          }
        } catch {
          /* ignore */
        }
        if (audio) {
          audio.pause();
          audio.removeAttribute('src');
          audio.load();
        }
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = null;
        mediaSource = null;
        if (this.currentAudio === audio) this.currentAudio = null;
      };

      const finishOk = (): void => {
        if (completed) return;
        completed = true;
        sub.unsubscribe();
        cleanup();
        resolve();
      };

      const finishErr = (err: Error): void => {
        if (completed) return;
        completed = true;
        sub.unsubscribe();
        cleanup();
        reject(err);
      };

      const notifyFirstChunk = (): void => {
        if (firstChunkSeen) return;
        firstChunkSeen = true;
        onFirstChunk();
      };

      const pumpAppend = async (): Promise<void> => {
        if (!useMseInner || !sourceBuffer) return;
        while (pendingAppend.length > 0 && sourceBuffer && useMseInner) {
          await this.waitSourceBuffer(sourceBuffer);
          if (!useMseInner || !sourceBuffer) break;
          const next = pendingAppend.shift();
          if (!next?.byteLength) continue;
          try {
            sourceBuffer.appendBuffer(new Uint8Array(next));
          } catch (err) {
            console.warn(
              '[TTS MSE] appendBuffer failed — falling back to buffered blob for this chunk.',
              err,
            );
            useMseInner = false;
            pendingAppend.unshift(next);
            break;
          }
        }
      };

      const schedulePump = (): void => {
        pumpTail = pumpTail.then(() => pumpAppend()).catch(() => {});
      };

      const finalizeBlob = async (): Promise<void> => {
        if (completed) return;
        const merged = this.mergeUint8Arrays(collected);
        if (merged.byteLength === 0) {
          finishOk();
          return;
        }
        await this.playAudioBufferFromUint8(merged, gen);
        finishOk();
      };

      const finalizeMse = async (): Promise<void> => {
        if (completed) return;
        if (!mediaSource || !sourceBuffer) {
          await finalizeBlob();
          return;
        }
        try {
          await pumpTail;
        } catch {
          /* ignore */
        }
        await pumpAppend();
        if (sourceBuffer) await this.waitSourceBuffer(sourceBuffer);
        try {
          if (mediaSource.readyState === 'open') {
            mediaSource.endOfStream();
          }
        } catch {
          /* ignore */
        }
        if (!audio || gen !== this.speechGen) {
          finishOk();
          return;
        }
        await new Promise<void>((r) => {
          const el = audio!;
          const onDone = (): void => {
            el.removeEventListener('ended', onDone);
            el.removeEventListener('error', onDone);
            r();
          };
          el.addEventListener('ended', onDone);
          el.addEventListener('error', onDone);
          if (el.ended) onDone();
        });
        finishOk();
      };

      const maybeFinalize = (): void => {
        if (!streamComplete || completed) return;
        void (async () => {
          if (gen !== this.speechGen) {
            finishOk();
            return;
          }
          if (useMseInner && sourceIsOpen && sourceBuffer) {
            await finalizeMse();
          } else if (useMseInner && !sourceIsOpen) {
            /* wait for sourceopen to call maybeFinalize again */
          } else {
            await finalizeBlob();
          }
        })();
      };

      sub = this.electron.ttsStream$.subscribe({
        next: (packet) => {
          if (packet.seq !== seq || completed) return;
          if (gen !== this.speechGen) {
            finishOk();
            return;
          }
          if (packet.kind === 'chunk') {
            notifyFirstChunk();
            const u8 = new Uint8Array(packet.data);
            collected.push(u8);
            if (useMseInner) {
              pendingAppend.push(u8);
              schedulePump();
              void pumpTail.then(() => {
                if (streamComplete) maybeFinalize();
              });
            }
          } else if (packet.kind === 'end') {
            streamComplete = true;
            schedulePump();
            void pumpTail.then(() => maybeFinalize());
          } else if (packet.kind === 'error') {
            finishErr(new Error(packet.message));
          }
        },
        error: (e) => finishErr(e instanceof Error ? e : new Error(String(e))),
      });

      if (useMse) {
        mediaSource = new MediaSource();
        objectUrl = URL.createObjectURL(mediaSource);
        audio = new Audio(objectUrl);
        this.currentAudio = audio;

        mediaSource.addEventListener('sourceopen', () => {
          if (completed || gen !== this.speechGen) return;
          try {
            sourceBuffer = mediaSource!.addSourceBuffer(MIME);
          } catch (err) {
            console.warn(
              '[TTS MSE] addSourceBuffer failed — falling back to buffered blob for this chunk.',
              err,
            );
            useMseInner = false;
            sourceIsOpen = false;
            if (streamComplete) maybeFinalize();
            return;
          }
          sourceIsOpen = true;
          schedulePump();
          void pumpTail.then(() => {
            if (streamComplete) maybeFinalize();
          });
        });

        void audio.play().catch(() => {});
      }

      void this.electron.startTtsStreamRequest(text, voice, seq);
    });
  }

  private stopSpeech(): void {
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = null;
    }
  }

  onTalkRecordingBegan(talkEnabled: boolean, speechEnabled: boolean): void {
    if (!talkEnabled || !speechEnabled) return;
    const el = this.currentAudio;
    if (!el || el.ended || this.ttsPausedForTalk) return;
    el.pause();
    this.ttsPausedForTalk = true;
  }

  onTalkCaptureFinished(event: { hadSpeech: boolean }, talkEnabled: boolean): void {
    if (!talkEnabled) {
      if (this.ttsPausedForTalk && this.currentAudio && !this.currentAudio.ended) {
        void this.currentAudio.play().catch(() => {});
      }
      this.ttsPausedForTalk = false;
      return;
    }
    if (event.hadSpeech) {
      this.ttsPausedForTalk = false;
      this.invalidateSpeechPipeline();
      return;
    }
    if (this.ttsPausedForTalk && this.currentAudio && !this.currentAudio.ended) {
      void this.currentAudio.play().catch(() => {});
    }
    this.ttsPausedForTalk = false;
  }
}
