/**
 * Kokoro TTS playback: Python WAV via main process IPC; buffered playback per chunk.
 * Owns generation tokens so overlapping replies / toggle-off cancel in-flight work safely.
 */
import { Injectable, NgZone, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import { ElectronService } from './electron.service';

@Injectable({ providedIn: 'root' })
export class TtsPlaybackService {
  /** Max characters per Kokoro request — larger reduces HTTP round-trips; keep bounded for memory/time. */
  private static readonly TTS_CHUNK_MAX = 2200;

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
    void this.electron.abortTtsStream();
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

  async speakText(text: string, voice: string, speed: number): Promise<void> {
    // Invalidate prior playback and await main-process abort so the next `/tts` fetch is not
    // cancelled by a late `tts-stream-abort` (fire-and-forget abort raced `tts-stream-start`).
    this.speechGen++;
    await this.electron.abortTtsStream();
    this.stopSpeech();
    this.zone.run(() => this.ttsLoading.set(false));
    const gen = this.speechGen;
    const clean = text
      .replace(/<details class="llm-reasoning"[\s\S]*?<\/details>/gi, '')
      .replace(/<details class="llm-moe-panel[^"]*"[\s\S]*?<\/details>/gi, '')
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
      const n = chunks.length;
      if (n === 0) return;
      let seq = ++this.ttsStreamSeq;
      let nextWavPromise = this.collectTtsWav(chunks[0], voice, speed, seq, gen, () => {
        this.zone.run(() => this.ttsLoading.set(false));
      });
      for (let i = 0; i < n; i++) {
        if (gen !== this.speechGen) return;
        const wav = await nextWavPromise;
        if (i + 1 < n) {
          seq = ++this.ttsStreamSeq;
          nextWavPromise = this.collectTtsWav(chunks[i + 1], voice, speed, seq, gen, () => {});
        }
        await this.playAudioBufferFromUint8(wav, gen, 'audio/wav');
      }
    } catch (err) {
      console.error('TTS playback failed:', err);
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

  private async playAudioBufferFromUint8(data: Uint8Array, gen: number, mimeType: string): Promise<void> {
    if (data.byteLength === 0) return;
    return new Promise((resolve) => {
      if (gen !== this.speechGen) {
        resolve();
        return;
      }
      const blob = new Blob([new Uint8Array(data)], { type: mimeType });
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
   * Accumulate WAV bytes from Python for one utterance (one HTTP `/tts` request).
   * Used with prefetch: start the next collect while the previous WAV plays.
   */
  private collectTtsWav(
    text: string,
    voice: string,
    speed: number,
    seq: number,
    gen: number,
    onFirstNetworkChunk: () => void,
  ): Promise<Uint8Array> {
    if (gen !== this.speechGen) return Promise.resolve(new Uint8Array());

    return new Promise((resolve, reject) => {
      const collected: Uint8Array[] = [];
      let firstChunkSeen = false;
      let completed = false;

      const notifyFirstChunk = (): void => {
        if (firstChunkSeen) return;
        firstChunkSeen = true;
        onFirstNetworkChunk();
      };

      let sub: Subscription;

      const finishOk = (merged: Uint8Array): void => {
        if (completed) return;
        completed = true;
        sub.unsubscribe();
        resolve(merged);
      };

      const finishErr = (err: Error): void => {
        if (completed) return;
        completed = true;
        sub.unsubscribe();
        reject(err);
      };

      sub = this.electron.ttsStream$.subscribe({
        next: (packet) => {
          if (Number(packet.seq) !== seq || completed) return;
          if (gen !== this.speechGen) {
            finishOk(new Uint8Array());
            return;
          }
          if (packet.kind === 'chunk') {
            notifyFirstChunk();
            collected.push(new Uint8Array(packet.data));
          } else if (packet.kind === 'end') {
            finishOk(this.mergeUint8Arrays(collected));
          } else if (packet.kind === 'error') {
            finishErr(new Error(packet.message));
          }
        },
        error: (e) => finishErr(e instanceof Error ? e : new Error(String(e))),
      });

      void this.electron.startTtsStreamRequest(text, voice, speed, seq);
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
