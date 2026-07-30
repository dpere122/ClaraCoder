/**
 * Kokoro TTS playback: Python WAV via main process IPC; buffered playback per chunk.
 * Owns generation tokens so overlapping replies / toggle-off cancel in-flight work safely.
 */
import { Injectable, NgZone, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import { ElectronService } from './electron.service';

@Injectable({ providedIn: 'root' })
export class TtsPlaybackService {
  /** Local Kokoro: larger chunks (fast synthesis). */
  private static readonly LOCAL_CHUNK = {
    target: 1200,
    hardMax: 2200,
    flushMin: 120,
    flushMax: 900,
  };

  /**
   * Remote Qwen / OpenAI-compatible: buffer the full turn, then one TTS request on flush.
   * Chunk limits are effectively unbounded so {@link splitTextForTts} / speakText stay one-shot.
   * Mid-stream sentence flushes are disabled via {@link bufferUntilFlush}.
   */
  private static readonly REMOTE_ONE_SHOT_CHUNK = {
    target: Number.MAX_SAFE_INTEGER,
    hardMax: Number.MAX_SAFE_INTEGER,
    flushMin: Number.MAX_SAFE_INTEGER,
    flushMax: Number.MAX_SAFE_INTEGER,
  };

  private chunkTarget = TtsPlaybackService.LOCAL_CHUNK.target;
  private chunkHardMax = TtsPlaybackService.LOCAL_CHUNK.hardMax;
  private streamFlushMin = TtsPlaybackService.LOCAL_CHUNK.flushMin;
  private streamFlushMax = TtsPlaybackService.LOCAL_CHUNK.flushMax;
  /**
   * When true (openai-compatible): accumulate cleaned text while the LLM streams; synthesize
   * only on {@link flushStreamingAssistantText} as a single request for max GPU decode speed.
   */
  private bufferUntilFlush = false;

  /** Shown on the latest assistant bubble while the first chunk is in flight. */
  readonly ttsLoading = signal(false);

  private static readonly PLAYBACK_RMS_ALPHA = 0.2;

  private speechGen = 0;
  private ttsStreamSeq = 0;
  private currentAudio: HTMLAudioElement | null = null;
  /** True after we paused assistant TTS because talk mode picked up voice; cleared after capture ends. */
  private ttsPausedForTalk = false;

  private playbackContext: AudioContext | null = null;
  private playbackAnalyser: AnalyserNode | null = null;
  private playbackMediaSource: MediaElementAudioSourceNode | null = null;
  private playbackRafId: number | null = null;
  private playbackRmsSmoothed = 0;
  private readonly playbackTimeData = new Float32Array(2048);
  private readonly tickPlaybackMeter = (): void => {
    const el = this.currentAudio;
    if (!el || el.ended) {
      this.stopPlaybackMetering();
      return;
    }
    if (!el.paused && this.playbackAnalyser) {
      const instant = this.samplePlaybackAnalyserRms();
      const a = TtsPlaybackService.PLAYBACK_RMS_ALPHA;
      this.playbackRmsSmoothed = this.playbackRmsSmoothed * (1 - a) + instant * a;
    }
    this.playbackRafId = requestAnimationFrame(this.tickPlaybackMeter);
  };

  /** Prefix length of {@link stripForTts} output already emitted into the segment queue for this turn. */
  private streamingCommittedCleanLen = 0;
  /**
   * Exclusive end offset in clean text already dequeued for synthesis (spoken or in-flight).
   * Prevents divergent ``final_text`` from re-queuing already-spoken lines.
   */
  private streamingSpokenCleanLen = 0;
  /** Last raw primary text length fed for this turn (detect true turn resets vs strip shrink). */
  private streamingRawLen = 0;
  /** Previous full {@link stripForTts} snapshot — used to realign when stripping shortens text. */
  private streamingCleanSnapshot = '';
  /**
   * Queued utterances with the exclusive end offset in {@link streamingCleanSnapshot} /
   * current clean text at enqueue time. Offsets let strip-shrink drop fence-body segments without
   * discarding unplayed prefix sentences still waiting in the queue.
   */
  private readonly streamingSegmentQueue: { text: string; cleanEnd: number }[] = [];
  private streamingPipelineBusy = false;
  private streamingQueueSignal: (() => void) | null = null;
  /** True from {@link beginAssistantSpeechTurn} until {@link flushStreamingAssistantText} queues the tail. */
  private streamingSpeechTurnOpen = false;
  /** Settings fallback for OpenAI-compatible TTS ``instructions`` when the model omits a mood tag. */
  private ttsDefaultInstructions = '';
  /** Mood/tone from ``[[tts_mood: ...]]`` for the current speech turn (overrides default). */
  private streamingTurnInstructions = '';

  constructor(
    private readonly electron: ElectronService,
    private readonly zone: NgZone,
  ) {}

  /**
   * Kokoro: large incremental chunks (overlap LLM stream with synthesis).
   * OpenAI-compatible: buffer until the turn ends, then one TTS shot.
   */
  setTtsChunkProfile(provider: 'kokoro' | 'openai-compatible'): void {
    const profile =
      provider === 'openai-compatible'
        ? TtsPlaybackService.REMOTE_ONE_SHOT_CHUNK
        : TtsPlaybackService.LOCAL_CHUNK;
    this.chunkTarget = profile.target;
    this.chunkHardMax = profile.hardMax;
    this.streamFlushMin = profile.flushMin;
    this.streamFlushMax = profile.flushMax;
    this.bufferUntilFlush = provider === 'openai-compatible';
  }

  /** Baseline Qwen/OpenAI-compatible ``instructions`` when the model does not emit a mood tag. */
  setTtsDefaultInstructions(instructions: string): void {
    this.ttsDefaultInstructions = (instructions || '').trim();
  }

  getCurrentAudio(): HTMLAudioElement | null {
    return this.currentAudio;
  }

  /** Smoothed RMS of assistant TTS output (0 when idle). Used for talk-mode barge-in gating. */
  getPlaybackRms(): number {
    return this.playbackRmsSmoothed;
  }

  isAssistantPlaying(): boolean {
    const el = this.currentAudio;
    return el != null && !el.ended && !el.paused;
  }

  /** Bump generation, stop playback, clear TTS loading UI (e.g. speech toggled off). */
  async invalidateSpeechPipeline(): Promise<void> {
    this.speechGen++;
    // Await abort so a late abort cannot cancel the next ``tts-stream-start``.
    await this.electron.abortTtsStream();
    this.stopSpeech();
    this.streamingCommittedCleanLen = 0;
    this.streamingSpokenCleanLen = 0;
    this.streamingRawLen = 0;
    this.streamingCleanSnapshot = '';
    this.streamingSegmentQueue.length = 0;
    this.streamingPipelineBusy = false;
    this.streamingSpeechTurnOpen = false;
    this.streamingTurnInstructions = '';
    this.notifyStreamingQueueChanged();
    this.zone.run(() => this.ttsLoading.set(false));
  }

  /**
   * Begin a new assistant turn while speech is enabled — stops prior audio and resets streaming buffers.
   * Call when the user sends a message so main-channel TTS does not overlap the previous reply.
   */
  async beginAssistantSpeechTurn(): Promise<void> {
    await this.invalidateSpeechPipeline();
    this.streamingSpeechTurnOpen = true;
  }

  private resolveTtsInstructions(): string {
    return this.streamingTurnInstructions || this.ttsDefaultInstructions;
  }

  /** Pull ``[[tts_mood: ...]]`` tags (latest wins) and remove them from spoken text. */
  private absorbMoodTags(text: string): string {
    let latest: string | null = null;
    // Fresh regex each call — global ``lastIndex`` on a shared RegExp is unsafe across feeds.
    const re = /\[\[tts_mood:\s*([^\]]+)\]\]/gi;
    const without = text.replace(re, (_full, mood: string) => {
      const trimmed = String(mood || '').trim();
      if (trimmed) latest = trimmed;
      return '';
    });
    if (latest) {
      this.streamingTurnInstructions = latest;
    }
    return without;
  }

  /** Same normalization as full-turn {@link speakText} so incremental synthesis matches batch playback. */
  private stripForTts(text: string): string {
    return this.absorbMoodTags(text)
      .replace(/<details class="llm-reasoning"[\s\S]*?<\/details>/gi, '')
      .replace(/<details class="llm-(?:moe|reasoning)-panel[^"]*"[\s\S]*?<\/details>/gi, '')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/#{1,6}\s+/g, '')
      .replace(/[*_~]{1,3}/g, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu, '')
      .replace(/\n{2,}/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  private static longestCommonPrefixLen(a: string, b: string): number {
    let lcp = 0;
    const limit = Math.min(a.length, b.length);
    while (lcp < limit && a[lcp] === b[lcp]) {
      lcp++;
    }
    return lcp;
  }

  /**
   * Feed cumulative sanitized primary-assistant text while the model streams.
   * Kokoro: queues speech at sentence/word boundaries.
   * OpenAI-compatible ({@link bufferUntilFlush}): only updates the buffer; synthesis waits for flush.
   */
  feedStreamingAssistantText(sanitizedFullPrimary: string, voice: string, speed: number): void {
    const raw = sanitizedFullPrimary;
    if (!raw) return;
    if (raw.length < this.streamingRawLen) {
      this.streamingCommittedCleanLen = 0;
      this.streamingSpokenCleanLen = 0;
      this.streamingRawLen = 0;
      this.streamingCleanSnapshot = '';
      this.streamingSegmentQueue.length = 0;
      this.streamingTurnInstructions = '';
    }
    this.streamingRawLen = raw.length;

    const clean = this.stripForTts(raw);
    if (!clean) return;

    if (this.realignStreamingCommitAfterStripShrink(clean) === 'divergent') {
      // Spoken prefix no longer matches incoming text — keep the streamed snapshot; wait for flush.
      if (!this.bufferUntilFlush) {
        void this.ensureStreamingPipeline(voice, speed);
      }
      return;
    }

    // One-shot remote TTS: keep the cleaned snapshot (and mood tags) warm; do not HTTP yet.
    if (this.bufferUntilFlush) {
      this.streamingCleanSnapshot = clean;
      return;
    }

    const base = Math.max(this.streamingCommittedCleanLen, this.streamingSpokenCleanLen);
    const tail = clean.slice(base);
    const { segments, keep } = this.extractStreamingSegments(tail);
    for (const s of segments) {
      this.streamingSegmentQueue.push({ text: s.text, cleanEnd: base + s.end });
    }
    if (segments.length > 0) {
      this.notifyStreamingQueueChanged();
    }
    this.streamingCommittedCleanLen = clean.length - keep.length;
    this.streamingCleanSnapshot = clean;
    void this.ensureStreamingPipeline(voice, speed);
  }

  /**
   * {@link stripForTts} is not monotonic while markdown/code fences stream in (a completed fence
   * removes text that was already counted). Realign to the longest common prefix instead of
   * resetting to zero, which would re-queue and replay from the beginning.
   *
   * Important: strip output can grow overall while still diverging in the middle (fence closes and
   * more prose arrives in the same chunk). Length-only checks miss that case and leave
   * `streamingCommittedCleanLen` pointing into the wrong suffix, skipping the start of new prose.
   *
   * Keep queued segments that end within the preserved prefix; drop only segments that came from
   * removed content (e.g. an open fence body). Clearing the entire queue used to skip unplayed
   * sentences before the fence when playback lagged the stream.
   *
   * When LCP falls below the spoken watermark (divergent ``final_text`` rewrite), return
   * ``divergent`` so callers do not re-queue already-spoken lines from the rewrite.
   */
  private realignStreamingCommitAfterStripShrink(clean: string): 'ok' | 'divergent' {
    const prev = this.streamingCleanSnapshot;
    if (!prev || clean.startsWith(prev)) {
      return 'ok';
    }
    const lcp = TtsPlaybackService.longestCommonPrefixLen(prev, clean);
    if (lcp < this.streamingSpokenCleanLen) {
      return 'divergent';
    }
    const kept = this.streamingSegmentQueue.filter((s) => s.cleanEnd <= lcp);
    this.streamingSegmentQueue.length = 0;
    this.streamingSegmentQueue.push(...kept);
    this.streamingCommittedCleanLen = Math.min(this.streamingCommittedCleanLen, lcp);
    // Do not re-queue text that was already dequeued for synthesis and is still in the prefix.
    this.streamingCommittedCleanLen = Math.max(this.streamingCommittedCleanLen, this.streamingSpokenCleanLen);
    return 'ok';
  }

  /**
   * Speak any tail left buffered when the SSE stream completes (also covers enabling speech only after streaming).
   * With {@link bufferUntilFlush}, the entire remaining clean text becomes one TTS request.
   */
  async flushStreamingAssistantText(sanitizedFullPrimary: string, voice: string, speed: number): Promise<void> {
    const clean = this.stripForTts(sanitizedFullPrimary);

    if (this.realignStreamingCommitAfterStripShrink(clean) === 'divergent') {
      // Ignore rewrite for TTS; speak only the remaining uncommitted tail of the streamed snapshot.
      const prev = this.streamingCleanSnapshot;
      const base = Math.max(this.streamingCommittedCleanLen, this.streamingSpokenCleanLen);
      const tail = prev.slice(base);
      if (tail.trim()) {
        this.enqueueUtterancePieces(tail.trim(), prev.length);
        this.notifyStreamingQueueChanged();
      }
      this.streamingCommittedCleanLen = prev.length;
      this.streamingSpeechTurnOpen = false;
      this.notifyStreamingQueueChanged();
      await this.ensureStreamingPipeline(voice, speed);
      return;
    }
    const base = Math.max(this.streamingCommittedCleanLen, this.streamingSpokenCleanLen);
    const tail = clean.slice(base);
    if (tail.trim()) {
      this.enqueueUtterancePieces(tail.trim(), clean.length);
      this.notifyStreamingQueueChanged();
    }
    this.streamingCommittedCleanLen = clean.length;
    this.streamingRawLen = sanitizedFullPrimary.length;
    this.streamingCleanSnapshot = clean;
    this.streamingSpeechTurnOpen = false;
    this.notifyStreamingQueueChanged();
    await this.ensureStreamingPipeline(voice, speed);
  }

  /** Queue one piece (one-shot) or sentence-split pieces (Kokoro overlap). */
  private enqueueUtterancePieces(text: string, cleanEnd: number): void {
    if (this.bufferUntilFlush) {
      this.streamingSegmentQueue.push({ text, cleanEnd });
      return;
    }
    for (const s of this.splitTextForTts(text)) {
      this.streamingSegmentQueue.push({ text: s, cleanEnd });
    }
  }

  private notifyStreamingQueueChanged(): void {
    const signal = this.streamingQueueSignal;
    if (!signal) return;
    this.streamingQueueSignal = null;
    signal();
  }

  /**
   * Wait for the next queued segment. While the assistant is still streaming, do not resolve
   * when the current clip ends — only when more text is queued or the turn is flushed.
   */
  private waitForNextSegmentDuringPlayback(playback: Promise<void>, gen: number): Promise<string | null> {
    if (gen !== this.speechGen) return Promise.resolve(null);

    const take = (): string | null => {
      if (gen !== this.speechGen) return null;
      return this.takeNextStreamingBatch();
    };

    const immediate = take();
    if (immediate) return Promise.resolve(immediate);
    // Turn already flushed: re-check the queue once — flush may have enqueued the tail between
    // the empty take above and this closed-turn check (otherwise the final sentences are dropped).
    if (!this.streamingSpeechTurnOpen) return Promise.resolve(take());

    return new Promise((resolve) => {
      let settled = false;

      const settle = (seg: string | null): void => {
        if (settled) return;
        settled = true;
        if (this.streamingQueueSignal === onQueue) {
          this.streamingQueueSignal = null;
        }
        resolve(seg);
      };

      const poll = (): void => {
        if (settled) return;
        if (gen !== this.speechGen) {
          settle(null);
          return;
        }
        const seg = take();
        if (seg) {
          settle(seg);
          return;
        }
        if (!this.streamingSpeechTurnOpen) {
          settle(null);
        }
      };

      const onQueue = (): void => poll();
      this.streamingQueueSignal = onQueue;
      poll();
      void playback.finally(() => poll());
    });
  }

  private takeFlushablePrefix(tail: string): { flush: string; keep: string } {
    if (!tail) return { flush: '', keep: '' };
    const min = this.streamFlushMin;
    const max = this.streamFlushMax;
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

  private extractStreamingSegments(tail: string): { segments: { text: string; end: number }[]; keep: string } {
    const segments: { text: string; end: number }[] = [];
    let rest = tail;
    let offset = 0;
    while (rest.length > 0) {
      const { flush, keep } = this.takeFlushablePrefix(rest);
      if (!flush) break;
      const flushEnd = offset + flush.length;
      const trimmed = flush.trim();
      if (trimmed) {
        for (const s of this.splitTextForTts(trimmed)) {
          // Conservative end: all pieces from this flush share the flush boundary in clean text.
          segments.push({ text: s, end: flushEnd });
        }
      }
      offset = flushEnd;
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
        const instructions = this.resolveTtsInstructions();
        let nextWavPromise = this.collectTtsWav(first, voice, speed, seq, gen, instructions, () => {
          this.zone.run(() => this.ttsLoading.set(false));
        });
        while (gen === this.speechGen) {
          const wav = await nextWavPromise;
          let nextSeg = this.takeNextStreamingBatch();
          if (nextSeg) {
            seq = ++this.ttsStreamSeq;
            nextWavPromise = this.collectTtsWav(
              nextSeg,
              voice,
              speed,
              seq,
              gen,
              this.resolveTtsInstructions(),
              () => {},
            );
          }
          const playback = this.playAudioBufferFromUint8(wav, gen, 'audio/wav');
          if (!nextSeg) {
            nextSeg = await this.waitForNextSegmentDuringPlayback(playback, gen);
            if (gen !== this.speechGen) return;
            if (nextSeg) {
              seq = ++this.ttsStreamSeq;
              nextWavPromise = this.collectTtsWav(
                nextSeg,
                voice,
                speed,
                seq,
                gen,
                this.resolveTtsInstructions(),
                () => {},
              );
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
   * Split for TTS at sentence / line / word boundaries so the first chunk returns audio sooner.
   */
  private splitTextForTts(text: string): string[] {
    const trimmed = text.trim();
    if (!trimmed) return [];

    const target = this.chunkTarget;
    const hard = this.chunkHardMax;
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

    const target = this.chunkTarget;
    const parts = [first.text];
    let len = first.text.length;
    let maxCleanEnd = first.cleanEnd;
    while (this.streamingSegmentQueue.length > 0) {
      const next = this.streamingSegmentQueue[0];
      if (len + 1 + next.text.length > target) break;
      const taken = this.streamingSegmentQueue.shift()!;
      parts.push(taken.text);
      len += 1 + taken.text.length;
      maxCleanEnd = Math.max(maxCleanEnd, taken.cleanEnd);
    }
    this.streamingSpokenCleanLen = Math.max(this.streamingSpokenCleanLen, maxCleanEnd);
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
    this.streamingSpokenCleanLen = 0;
    this.streamingRawLen = 0;
    this.streamingCleanSnapshot = '';
    this.streamingSegmentQueue.length = 0;
    this.streamingPipelineBusy = false;
    this.streamingSpeechTurnOpen = false;
    this.streamingTurnInstructions = '';
    await this.electron.abortTtsStream();
    this.stopSpeech();
    this.zone.run(() => this.ttsLoading.set(false));
    const gen = this.speechGen;
    const clean = this.stripForTts(text);
    if (!clean) return;
    const chunks = this.bufferUntilFlush ? [clean] : this.splitTextForTts(clean);
    const instructions = this.resolveTtsInstructions();
    this.zone.run(() => this.ttsLoading.set(true));
    try {
      const n = chunks.length;
      if (n === 0) return;
      let seq = ++this.ttsStreamSeq;
      let nextWavPromise = this.collectTtsWav(chunks[0], voice, speed, seq, gen, instructions, () => {
        this.zone.run(() => this.ttsLoading.set(false));
      });
      for (let i = 0; i < n; i++) {
        if (gen !== this.speechGen) return;
        const wav = await nextWavPromise;
        if (i + 1 < n) {
          seq = ++this.ttsStreamSeq;
          nextWavPromise = this.collectTtsWav(
            chunks[i + 1],
            voice,
            speed,
            seq,
            gen,
            instructions,
            () => {},
          );
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

  private ensurePlaybackContext(): AudioContext {
    if (!this.playbackContext) {
      this.playbackContext = new AudioContext();
      this.playbackAnalyser = this.playbackContext.createAnalyser();
      this.playbackAnalyser.fftSize = 2048;
      this.playbackAnalyser.connect(this.playbackContext.destination);
    }
    return this.playbackContext;
  }

  private samplePlaybackAnalyserRms(): number {
    const analyser = this.playbackAnalyser;
    if (!analyser) return 0;
    analyser.getFloatTimeDomainData(this.playbackTimeData);
    let sum = 0;
    for (let i = 0; i < this.playbackTimeData.length; i++) {
      const v = this.playbackTimeData[i];
      sum += v * v;
    }
    return Math.sqrt(sum / this.playbackTimeData.length);
  }

  private stopPlaybackMetering(): void {
    if (this.playbackRafId != null) {
      cancelAnimationFrame(this.playbackRafId);
      this.playbackRafId = null;
    }
    this.playbackRmsSmoothed = 0;
  }

  private disconnectPlaybackMediaSource(): void {
    this.stopPlaybackMetering();
    try {
      this.playbackMediaSource?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.playbackMediaSource = null;
  }

  private connectPlaybackGraph(audio: HTMLAudioElement): void {
    const ctx = this.ensurePlaybackContext();
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }
    this.disconnectPlaybackMediaSource();
    this.playbackMediaSource = ctx.createMediaElementSource(audio);
    this.playbackMediaSource.connect(this.playbackAnalyser!);
    this.playbackRafId = requestAnimationFrame(this.tickPlaybackMeter);
  }

  private async playAudioBufferFromUint8(data: Uint8Array, gen: number, mimeType: string): Promise<void> {
    if (data.byteLength === 0) return;
    return new Promise((resolve) => {
      if (gen !== this.speechGen) {
        resolve();
        return;
      }
      const blob = new Blob([data as BlobPart], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.preload = 'auto';
      this.currentAudio = audio;
      this.connectPlaybackGraph(audio);
      const done = (): void => {
        URL.revokeObjectURL(url);
        if (this.currentAudio === audio) {
          this.disconnectPlaybackMediaSource();
          this.currentAudio = null;
        }
        resolve();
      };
      audio.onended = done;
      audio.onerror = done;
      const start = (): void => {
        void audio.play().catch(() => done());
      };
      if (audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
        start();
      } else {
        audio.addEventListener('canplay', start, { once: true });
        audio.load();
      }
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
    instructions: string,
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
      let genWatch: ReturnType<typeof setInterval> | undefined;

      const finishOk = (merged: Uint8Array): void => {
        if (completed) return;
        completed = true;
        if (genWatch != null) clearInterval(genWatch);
        sub.unsubscribe();
        resolve(merged);
      };

      const finishErr = (err: Error): void => {
        if (completed) return;
        completed = true;
        if (genWatch != null) clearInterval(genWatch);
        sub.unsubscribe();
        reject(err);
      };

      // Resolve immediately if generation bumps before a terminal packet arrives.
      genWatch = setInterval(() => {
        if (gen !== this.speechGen) {
          finishOk(new Uint8Array());
        }
      }, 40);

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

      void this.electron.startTtsStreamRequest(text, voice, speed, seq, instructions);
    });
  }

  private stopSpeech(): void {
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = null;
    }
    this.disconnectPlaybackMediaSource();
  }

  onTalkRecordingBegan(talkEnabled: boolean, speechEnabled: boolean): void {
    if (!talkEnabled || !speechEnabled) return;
    const el = this.currentAudio;
    if (!el || el.ended || this.ttsPausedForTalk) return;
    el.pause();
    this.ttsPausedForTalk = true;
  }

  onTalkCaptureFinished(
    event: { hadSpeech: boolean; userBargeIn: boolean },
    talkEnabled: boolean,
  ): void {
    const resumePaused = (): void => {
      if (this.ttsPausedForTalk && this.currentAudio && !this.currentAudio.ended) {
        void this.currentAudio.play().catch(() => {});
      }
      this.ttsPausedForTalk = false;
    };

    if (!talkEnabled) {
      resumePaused();
      return;
    }
    if (event.userBargeIn && event.hadSpeech) {
      this.ttsPausedForTalk = false;
      void this.invalidateSpeechPipeline();
      return;
    }
    resumePaused();
  }
}
