/**
 * Kokoro TTS playback: Python WAV via main process IPC; buffered playback per chunk.
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

  async speakText(text: string, voice: string, speed: number): Promise<void> {
    this.invalidateSpeechPipeline();
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
      for (let i = 0; i < chunks.length; i++) {
        if (gen !== this.speechGen) return;
        const seq = ++this.ttsStreamSeq;
        await this.playTtsStreamChunk(chunks[i], voice, speed, seq, gen, () => {
          if (i === 0) this.zone.run(() => this.ttsLoading.set(false));
        });
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
   * Pulls WAV from Python via the main process: accumulate streamed bytes, then play as one blob
   * (Kokoro returns complete WAV per request; MP3/MSE path is not used).
   */
  private playTtsStreamChunk(
    text: string,
    voice: string,
    speed: number,
    seq: number,
    gen: number,
    onFirstChunk: () => void,
  ): Promise<void> {
    if (gen !== this.speechGen) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const collected: Uint8Array[] = [];
      let firstChunkSeen = false;
      let completed = false;

      const notifyFirstChunk = (): void => {
        if (firstChunkSeen) return;
        firstChunkSeen = true;
        onFirstChunk();
      };

      let sub: Subscription;

      const finishOk = (): void => {
        if (completed) return;
        completed = true;
        sub.unsubscribe();
        resolve();
      };

      const finishErr = (err: Error): void => {
        if (completed) return;
        completed = true;
        sub.unsubscribe();
        reject(err);
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
            collected.push(new Uint8Array(packet.data));
          } else if (packet.kind === 'end') {
            const merged = this.mergeUint8Arrays(collected);
            void this.playAudioBufferFromUint8(merged, gen, 'audio/wav').then(finishOk).catch(finishErr);
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
