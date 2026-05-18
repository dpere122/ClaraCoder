/**
 * Kokoro TTS playback: Python WAV via main process IPC; buffered playback per chunk.
 * Owns generation tokens so overlapping replies / toggle-off cancel in-flight work safely.
 */
import { Injectable, NgZone, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import { ElectronService } from './electron.service';

@Injectable({ providedIn: 'root' })
export class TtsPlaybackService {
  /**
   * Preferred max characters per Kokoro request. Smaller chunks improve time-to-first-audio; the
   * next chunk prefetches while the current WAV plays ({@link collectTtsWav} pipelining).
   */
  private static readonly TTS_CHUNK_TARGET = 1200;

  /** Never exceed this many characters in one `/tts` body (e.g. huge unpunctuated spans). */
  private static readonly TTS_CHUNK_HARD_MAX = 2200;

  /** Prefer flushing streaming speech after at least this many characters (unless forced below). */
  private static readonly STREAM_FLUSH_MIN = 120;

  /** Force a boundary flush near this length when no sentence break appears yet. */
  private static readonly STREAM_FLUSH_MAX = 900;

  /** Shown on the latest assistant bubble while the first chunk is in flight. */
  readonly ttsLoading = signal(false);

  private speechGen = 0;
  private ttsStreamSeq = 0;
  private currentAudio: HTMLAudioElement | null = null;
  /** True after we paused assistant TTS because talk mode picked up voice; cleared after capture ends. */
  private ttsPausedForTalk = false;

  /** Prefix length of {@link stripForTts} output already emitted into the segment queue for this turn. */
  private streamingCommittedCleanLen = 0;
  private readonly streamingSegmentQueue: string[] = [];
  private streamingPipelineBusy = false;
  private streamingQueueSignal: (() => void) | null = null;

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
    this.streamingCommittedCleanLen = 0;
    this.streamingSegmentQueue.length = 0;
    this.streamingPipelineBusy = false;
    this.notifyStreamingQueueChanged();
    this.zone.run(() => this.ttsLoading.set(false));
  }

  /**
   * Begin a new assistant turn while speech is enabled — stops prior audio and resets streaming buffers.
   * Call when the user sends a message so main-channel TTS does not overlap the previous reply.
   */
  beginAssistantSpeechTurn(): void {
    this.invalidateSpeechPipeline();
  }

  /** Same normalization as full-turn {@link speakText} so incremental synthesis matches batch playback. */
  private stripForTts(text: string): string {
    return text
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
  }

  /**
   * Feed cumulative sanitized primary-assistant text while the model streams; queues speech at sentence/word boundaries.
   */
  feedStreamingAssistantText(sanitizedFullPrimary: string, voice: string, speed: number): void {
    const clean = this.stripForTts(sanitizedFullPrimary);
    if (!clean) return;
    if (clean.length < this.streamingCommittedCleanLen) {
      this.streamingCommittedCleanLen = 0;
      this.streamingSegmentQueue.length = 0;
    }
    const tail = clean.slice(this.streamingCommittedCleanLen);
    const { segments, keep } = this.extractStreamingSegments(tail);
    for (const s of segments) {
      this.streamingSegmentQueue.push(s);
    }
    if (segments.length > 0) {
      this.notifyStreamingQueueChanged();
    }
    this.streamingCommittedCleanLen = clean.length - keep.length;
    void this.ensureStreamingPipeline(voice, speed);
  }

  /**
   * Speak any tail left buffered when the SSE stream completes (also covers enabling speech only after streaming).
   */
  async flushStreamingAssistantText(sanitizedFullPrimary: string, voice: string, speed: number): Promise<void> {
    const clean = this.stripForTts(sanitizedFullPrimary);
    const tail = clean.slice(this.streamingCommittedCleanLen);
    if (tail.trim()) {
      for (const s of this.splitTextForTts(tail.trim())) {
        this.streamingSegmentQueue.push(s);
      }
      this.notifyStreamingQueueChanged();
    }
    this.streamingCommittedCleanLen = clean.length;
    await this.ensureStreamingPipeline(voice, speed);
  }

  private notifyStreamingQueueChanged(): void {
    const signal = this.streamingQueueSignal;
    if (!signal) return;
    this.streamingQueueSignal = null;
    signal();
  }

  private waitForQueueOrPlayback(playback: Promise<void>): Promise<'queue' | 'playback'> {
    if (this.streamingSegmentQueue.length > 0) {
      return Promise.resolve('queue');
    }
    return new Promise((resolve) => {
      let settled = false;
      const signal = (): void => {
        if (settled) return;
        settled = true;
        if (this.streamingQueueSignal === signal) {
          this.streamingQueueSignal = null;
        }
        resolve('queue');
      };
      this.streamingQueueSignal = signal;
      void playback.finally(() => {
        if (settled) return;
        settled = true;
        if (this.streamingQueueSignal === signal) {
          this.streamingQueueSignal = null;
        }
        resolve('playback');
      });
    });
  }

  private takeFlushablePrefix(tail: string): { flush: string; keep: string } {
    if (!tail) return { flush: '', keep: '' };
    const min = TtsPlaybackService.STREAM_FLUSH_MIN;
    const max = TtsPlaybackService.STREAM_FLUSH_MAX;
    if (tail.length < min) {
      return { flush: '', keep: tail };
    }
    const limited = tail.slice(0, Math.min(tail.length, max));
    let cut = -1;
    for (let i = min - 1; i < limited.length; i++) {
      const ch = limited[i];
      if ((ch === '.' || ch === '?' || ch === '!') && (i === limited.length - 1 || /\s/.test(limited[i + 1] ?? ''))) {
        cut = i + 1;
        while (cut < limited.length && /\s/.test(limited[cut])) cut++;
        break;
      }
    }
    if (cut < 0) {
      const para = limited.indexOf('\n\n');
      if (para >= min - 1) {
        cut = para + 2;
      }
    }
    if (cut < 0 && tail.length >= max) {
      const sp = limited.lastIndexOf(' ');
      cut = sp >= min - 1 ? sp + 1 : max;
    }
    if (cut < 0) {
      return { flush: '', keep: tail };
    }
    return { flush: tail.slice(0, cut), keep: tail.slice(cut) };
  }

  private extractStreamingSegments(tail: string): { segments: string[]; keep: string } {
    const segments: string[] = [];
    let rest = tail;
    while (rest.length > 0) {
      const { flush, keep } = this.takeFlushablePrefix(rest);
      if (!flush) break;
      const trimmed = flush.trim();
      if (trimmed) {
        for (const s of this.splitTextForTts(trimmed)) {
          segments.push(s);
        }
      }
      rest = keep;
    }
    return { segments, keep: rest };
  }

  private async ensureStreamingPipeline(voice: string, speed: number): Promise<void> {
    const gen = this.speechGen;
    if (this.streamingPipelineBusy) return;
    if (this.streamingSegmentQueue.length === 0) return;
    this.streamingPipelineBusy = true;
    this.zone.run(() => this.ttsLoading.set(true));
    try {
      while (gen === this.speechGen && this.streamingSegmentQueue.length > 0) {
        let first = this.takeNextStreamingBatch()!;
        let seq = ++this.ttsStreamSeq;
        let nextWavPromise = this.collectTtsWav(first, voice, speed, seq, gen, () => {
          this.zone.run(() => this.ttsLoading.set(false));
        });
        while (gen === this.speechGen) {
          const wav = await nextWavPromise;
          let nextSeg = this.takeNextStreamingBatch();
          if (nextSeg) {
            seq = ++this.ttsStreamSeq;
            nextWavPromise = this.collectTtsWav(nextSeg, voice, speed, seq, gen, () => {});
          }
          const playback = this.playAudioBufferFromUint8(wav, gen, 'audio/wav');
          if (!nextSeg) {
            const outcome = await this.waitForQueueOrPlayback(playback);
            if (gen !== this.speechGen) return;
            if (outcome === 'queue' && gen === this.speechGen) {
              nextSeg = this.takeNextStreamingBatch();
              if (nextSeg) {
                seq = ++this.ttsStreamSeq;
                nextWavPromise = this.collectTtsWav(nextSeg, voice, speed, seq, gen, () => {});
                await playback;
                continue;
              }
            }
          }
          await playback;
          if (!nextSeg) break;
        }
      }
    } catch (err) {
      console.error('TTS streaming playback failed:', err);
    } finally {
      if (this.speechGen === gen) {
        this.zone.run(() => this.ttsLoading.set(false));
      }
      this.streamingPipelineBusy = false;
      if (gen === this.speechGen && this.streamingSegmentQueue.length > 0) {
        void this.ensureStreamingPipeline(voice, speed);
      }
    }
  }

  /**
   * Split for TTS: always prefer multiple smaller Kokoro requests (up to {@link TTS_CHUNK_TARGET})
   * at sentence / line / word boundaries so the first chunk returns audio sooner; merge sub-pieces
   * that still exceed {@link TTS_CHUNK_HARD_MAX}.
   */
  private splitTextForTts(text: string): string[] {
    const trimmed = text.trim();
    if (!trimmed) return [];

    const target = TtsPlaybackService.TTS_CHUNK_TARGET;
    const hard = TtsPlaybackService.TTS_CHUNK_HARD_MAX;
    const out: string[] = [];
    let rest = trimmed;

    while (rest.length > 0) {
      if (rest.length <= target) {
        out.push(...this.splitHardMaxOnly(rest, hard));
        break;
      }
      let end = this.findPreferredChunkEnd(rest, target);
      let rawPiece = rest.slice(0, end).trim();
      if (!rawPiece && rest.length > 0) {
        end = 1;
        rawPiece = rest.slice(0, end).trim();
      }
      rest = rest.slice(end).trim();
      if (!rawPiece) break;
      out.push(...this.splitHardMaxOnly(rawPiece, hard));
    }

    return out.length > 0 ? out : [trimmed];
  }

  private takeNextStreamingBatch(): string | null {
    const first = this.streamingSegmentQueue.shift();
    if (!first) return null;
    const target = TtsPlaybackService.TTS_CHUNK_TARGET;
    const parts = [first];
    let len = first.length;
    while (this.streamingSegmentQueue.length > 0) {
      const next = this.streamingSegmentQueue[0];
      if (len + 1 + next.length > target) break;
      parts.push(this.streamingSegmentQueue.shift()!);
      len += 1 + next.length;
    }
    return parts.join(' ').trim() || null;
  }

  /** Exclusive end index: first chunk is `rest.slice(0, end)` (at most `limit` chars). */
  private findPreferredChunkEnd(rest: string, limit: number): number {
    const lim = Math.min(limit, rest.length);
    const win = lim >= rest.length ? rest : rest.slice(0, lim);
    const minRel = Math.floor(lim * 0.35);

    const endAfterPair = (pair: string): number => {
      const c = win.lastIndexOf(pair);
      return c >= minRel ? c + pair.length : -1;
    };

    let end = endAfterPair('. ');
    if (end < 0) end = endAfterPair('? ');
    if (end < 0) end = endAfterPair('! ');
    if (end < 0) {
      const nl = win.lastIndexOf('\n');
      if (nl >= minRel) end = nl + 1;
    }
    if (end < 0) {
      const sp = win.lastIndexOf(' ');
      if (sp >= minRel - 1 && sp > 0) end = sp + 1;
    }
    if (end < 0) end = lim;
    return Math.max(1, Math.min(end, rest.length));
  }

  /** Split only when a single piece exceeds the hard cap (rare long unpunctuated spans). */
  private splitHardMaxOnly(piece: string, hard: number): string[] {
    if (piece.length <= hard) return piece ? [piece] : [];
    const parts: string[] = [];
    let rest = piece;
    while (rest.length > hard) {
      const end = this.findPreferredChunkEnd(rest, hard);
      let seg = rest.slice(0, end).trim();
      let next = rest.slice(end).trim();
      if (!seg) {
        const take = Math.min(hard, rest.length);
        seg = rest.slice(0, take).trim() || rest.slice(0, 1);
        next = rest.slice(take).trim();
      }
      parts.push(seg);
      rest = next;
    }
    if (rest) parts.push(rest);
    return parts.length > 0 ? parts : [piece];
  }

  async speakText(text: string, voice: string, speed: number): Promise<void> {
    // Invalidate prior playback and await main-process abort so the next `/tts` fetch is not
    // cancelled by a late `tts-stream-abort` (fire-and-forget abort raced `tts-stream-start`).
    this.speechGen++;
    this.streamingCommittedCleanLen = 0;
    this.streamingSegmentQueue.length = 0;
    this.streamingPipelineBusy = false;
    await this.electron.abortTtsStream();
    this.stopSpeech();
    this.zone.run(() => this.ttsLoading.set(false));
    const gen = this.speechGen;
    const clean = this.stripForTts(text);
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
