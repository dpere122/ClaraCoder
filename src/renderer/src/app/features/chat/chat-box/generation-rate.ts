import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { formatTokensPerSecond, turnTokensPerSecond, type TurnGenerationStats } from '@shared/index';

import { ElectronService } from '../../../core/electron.service';

/** Tokens/sec the composer shows while a turn streams. */
export interface LiveGenerationRate {
  readonly tokensPerSecond: number;
  /** From streamed text length; false once the backend has reported exact usage for a model call. */
  readonly estimated: boolean;
}

/** Live estimate looks at the chunks of the last this-many ms. */
const LIVE_WINDOW_MS = 2000;
/** Gaps between chunks longer than this are tool runs or prefill, not decoding. */
const MAX_DECODE_GAP_MS = 1500;
/** Republish the live rate at most this often so the readout stays legible. */
const LIVE_PUBLISH_MS = 300;
const DEFAULT_CHARS_PER_TOKEN = 4;

interface ChunkSample {
  readonly at: number;
  readonly chars: number;
}

/** One turn's running totals. Exact figures come from `token_usage`; chars are the fallback. */
export class TurnRateTracker {
  private exactTokens = 0;
  private exactMs = 0;
  private streamedChars = 0;
  private decodeMs = 0;
  private stepChars = 0;
  private lastChunkAt: number | null = null;
  private window: ChunkSample[] = [];
  private lastPublishAt = Number.NEGATIVE_INFINITY;
  live: LiveGenerationRate | null = null;

  constructor(private charsPerToken: number) {}

  /** Returns true when {@link live} changed and should be republished. */
  onChunk(chars: number, at: number): boolean {
    if (chars <= 0) return false;
    if (this.lastChunkAt !== null) {
      const gap = at - this.lastChunkAt;
      if (gap > 0 && gap < MAX_DECODE_GAP_MS) this.decodeMs += gap;
    }
    this.lastChunkAt = at;
    this.streamedChars += chars;
    this.stepChars += chars;
    this.window.push({ at, chars });
    while (this.window.length > 0 && at - this.window[0].at > LIVE_WINDOW_MS) {
      this.window.shift();
    }
    if (at - this.lastPublishAt < LIVE_PUBLISH_MS || this.window.length < 3) return false;
    const span = at - this.window[0].at;
    if (span < LIVE_PUBLISH_MS) return false;
    // The first sample opens the window; only chars after it fall inside the span.
    const windowChars = this.window.reduce((sum, s) => sum + s.chars, 0) - this.window[0].chars;
    this.live = { tokensPerSecond: (windowChars / this.charsPerToken / span) * 1000, estimated: true };
    this.lastPublishAt = at;
    return true;
  }

  /**
   * One model call finished with measured usage. Returns the observed chars/token for this call
   * (to calibrate later estimates), or null when there is nothing to learn from.
   */
  onUsage(outputTokens: number, generationMs: number | undefined, at: number): number | null {
    const stepChars = this.stepChars;
    this.stepChars = 0;
    if (outputTokens <= 0) return null;
    if (generationMs && generationMs > 0) {
      this.exactTokens += outputTokens;
      this.exactMs += generationMs;
      this.live = { tokensPerSecond: (this.exactTokens * 1000) / this.exactMs, estimated: false };
      this.lastPublishAt = at;
      // The next call's estimate starts fresh instead of averaging across the tool run.
      this.window = [];
    }
    return stepChars > 0 ? stepChars / outputTokens : null;
  }

  setCharsPerToken(value: number): void {
    this.charsPerToken = value;
  }

  stats(): TurnGenerationStats | undefined {
    if (this.exactTokens > 0 && this.exactMs > 0) {
      return { outputTokens: this.exactTokens, generationMs: Math.round(this.exactMs) };
    }
    if (this.streamedChars > 0 && this.decodeMs >= LIVE_PUBLISH_MS) {
      return {
        outputTokens: Math.max(1, Math.round(this.streamedChars / this.charsPerToken)),
        generationMs: Math.round(this.decodeMs),
        estimated: true,
      };
    }
    return undefined;
  }
}

/**
 * Per-conversation tokens/sec. Streams a live estimate to the composer and hands the finished
 * turn's totals to {@link ConversationSessionService}, which saves them on the assistant message.
 */
@Injectable({ providedIn: 'root' })
export class GenerationRateService {
  private readonly electron = inject(ElectronService);
  private readonly trackers = new Map<string, TurnRateTracker>();
  /** Learned from exact usage; keeps estimates honest for code-heavy or CJK output. */
  private charsPerToken = DEFAULT_CHARS_PER_TOKEN;

  /** Live rate per conversation while its turn streams (absent before the first chunk). */
  readonly live = signal<Readonly<Record<string, LiveGenerationRate>>>({});

  constructor() {
    const destroyRef = inject(DestroyRef);
    this.electron.chunk$.pipe(takeUntilDestroyed(destroyRef)).subscribe(({ conversationId, delta }) => {
      const tracker = this.tracker(conversationId);
      if (tracker.onChunk(delta.length, performance.now())) this.publish(conversationId, tracker);
    });
    this.electron.llmTokenUsage$
      .pipe(takeUntilDestroyed(destroyRef))
      .subscribe(({ conversationId, outputTokens, generationMs }) => {
        const tracker = this.tracker(conversationId);
        const ratio = tracker.onUsage(outputTokens ?? 0, generationMs, performance.now());
        // Hidden reasoning / tool-call args inflate the token count, so clamp before blending.
        if (ratio !== null && ratio >= 1.5 && ratio <= 10) {
          this.charsPerToken = this.charsPerToken * 0.5 + ratio * 0.5;
          tracker.setCharsPerToken(this.charsPerToken);
        }
        this.publish(conversationId, tracker);
      });
  }

  /** Close the conversation's turn and return what it measured (undefined when nothing streamed). */
  finishTurn(conversationId: string): TurnGenerationStats | undefined {
    const tracker = this.trackers.get(conversationId);
    this.trackers.delete(conversationId);
    if (conversationId in this.live()) {
      this.live.update(({ [conversationId]: _done, ...rest }) => rest);
    }
    return tracker?.stats();
  }

  private tracker(conversationId: string): TurnRateTracker {
    let tracker = this.trackers.get(conversationId);
    if (!tracker) {
      tracker = new TurnRateTracker(this.charsPerToken);
      this.trackers.set(conversationId, tracker);
    }
    return tracker;
  }

  private publish(conversationId: string, tracker: TurnRateTracker): void {
    const live = tracker.live;
    if (live) this.live.update((prev) => ({ ...prev, [conversationId]: live }));
  }
}

/** Footer text under a finished assistant reply. */
export interface TurnGenerationSummary {
  /** `128 tok/s` (`~` prefix when estimated). */
  readonly rate: string;
  /** `341 tokens · 2.7s` */
  readonly detail: string;
  readonly title: string;
}

function formatGenerationSeconds(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, '0')}s`;
}

export function turnGenerationSummary(stats: TurnGenerationStats): TurnGenerationSummary | null {
  const tokensPerSecond = turnTokensPerSecond(stats);
  if (tokensPerSecond <= 0) return null;
  const tokens = `${stats.outputTokens.toLocaleString('en-US')} ${stats.outputTokens === 1 ? 'token' : 'tokens'}`;
  const seconds = formatGenerationSeconds(stats.generationMs);
  const approx = stats.estimated ? '~' : '';
  const title = stats.estimated
    ? `About ${tokens} in ${seconds} of streaming (estimated from text; the provider reported no usage)`
    : `${tokens} generated in ${seconds} (prompt processing and tool runs not counted)`;
  return {
    rate: `${approx}${formatTokensPerSecond(tokensPerSecond)} tok/s`,
    detail: `${approx}${tokens} · ${seconds}`,
    title,
  };
}
