import { NgZone } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TtsStreamPacket } from '@shared/index';
import { ElectronService } from './electron.service';
import { TtsPlaybackService } from './tts-playback.service';

function mockElectron() {
  const ttsStreamSubject = new Subject<TtsStreamPacket>();
  const electron = {
    ttsStream$: ttsStreamSubject.asObservable(),
    startTtsStreamRequest: async () => ({ ok: true }),
    abortTtsStream: async () => ({ ok: true }),
  } as unknown as ElectronService;
  return { electron, ttsStreamSubject };
}

function mockZone(): NgZone {
  return {
    run: <T>(fn: () => T): T => fn(),
  } as unknown as NgZone;
}

function internals(svc: TtsPlaybackService): {
  streamingCommittedCleanLen: number;
  streamingSpokenCleanLen: number;
  streamingSegmentQueue: { text: string; cleanEnd: number }[];
  streamingCleanSnapshot: string;
  streamingTurnInstructions: string;
  realignStreamingCommitAfterStripShrink: (clean: string) => 'ok' | 'divergent';
  ensureStreamingPipeline: (voice: string, speed: number) => Promise<void>;
  takeNextStreamingBatch: () => string | null;
  stripForTts: (text: string) => string;
} {
  return svc as unknown as {
    streamingCommittedCleanLen: number;
    streamingSpokenCleanLen: number;
    streamingSegmentQueue: { text: string; cleanEnd: number }[];
    streamingCleanSnapshot: string;
    streamingTurnInstructions: string;
    realignStreamingCommitAfterStripShrink: (clean: string) => 'ok' | 'divergent';
    ensureStreamingPipeline: (voice: string, speed: number) => Promise<void>;
    takeNextStreamingBatch: () => string | null;
    stripForTts: (text: string) => string;
  };
}

function queuedText(svc: TtsPlaybackService): string {
  return internals(svc)
    .streamingSegmentQueue.map((s) => s.text)
    .join(' ');
}

/** Long enough to exceed STREAM_FLUSH_MIN (120) with a sentence boundary. */
const LONG_A =
  'Alpha sentence stays queued until spoken and must survive the fence close event cleanly for sure. ';
const LONG_B =
  'Beta sentence is also before the fence and must not be dropped when stripping shortens the text. ';
const LONG_OUTRO =
  'Closing remark after the fence needs enough characters to flush as its own spoken segment for sure. ';

describe('TtsPlaybackService feedStreamingAssistantText', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  function setup(): TtsPlaybackService {
    const { electron } = mockElectron();
    TestBed.configureTestingModule({
      providers: [
        TtsPlaybackService,
        { provide: ElectronService, useValue: electron },
        { provide: NgZone, useValue: mockZone() },
      ],
    });
    const svc = TestBed.inject(TtsPlaybackService);
    vi.spyOn(internals(svc), 'ensureStreamingPipeline').mockResolvedValue(undefined);
    return svc;
  }

  it('does not reset committed progress when stripForTts shortens after a code fence closes', async () => {
    const svc = setup();
    const state = internals(svc);

    const intro =
      'This is the opening sentence before any code appears in the reply. ' +
      'It needs to be long enough to pass the streaming flush threshold. ';
    svc.feedStreamingAssistantText(`${intro}\`\`\`python\nx`, 'af_heart', 1);
    const committedAfterIntro = state.streamingCommittedCleanLen;
    expect(committedAfterIntro).toBeGreaterThan(0);
    expect(queuedText(svc)).toContain('opening sentence');

    const finalText = `${intro}\`\`\`python\nx\n\`\`\` ${LONG_OUTRO}${LONG_OUTRO}`;
    svc.feedStreamingAssistantText(finalText, 'af_heart', 1);
    await svc.flushStreamingAssistantText(finalText, 'af_heart', 1);

    expect(state.streamingCommittedCleanLen).toBeGreaterThanOrEqual(committedAfterIntro);
    expect(queuedText(svc)).toContain('opening sentence');
    expect(queuedText(svc)).toContain('Closing remark after the fence');
  });

  it('keeps unplayed prefix sentences when a fence closes even if overall clean text grows', () => {
    const svc = setup();
    const state = internals(svc);

    const fenceBody = '```py\n' + 'x = 1\n'.repeat(40) + '```';
    state.streamingCleanSnapshot = `${LONG_A}${LONG_B}${fenceBody}`;
    state.streamingCommittedCleanLen = state.streamingCleanSnapshot.length;
    state.streamingSegmentQueue.push(
      { text: LONG_A.trim(), cleanEnd: LONG_A.length },
      { text: LONG_B.trim(), cleanEnd: LONG_A.length + LONG_B.length },
      { text: 'code noise', cleanEnd: state.streamingCleanSnapshot.length },
    );

    // New strip output is longer than the snapshot but diverges after the intro (fence → outro).
    state.realignStreamingCommitAfterStripShrink(`${LONG_A}${LONG_B}${LONG_OUTRO}${LONG_OUTRO}`);

    const queued = queuedText(svc);
    expect(queued).toContain('Alpha sentence');
    expect(queued).toContain('Beta sentence');
    expect(queued).not.toContain('code noise');
    expect(state.streamingCommittedCleanLen).toBe((LONG_A + LONG_B).length);
  });

  it('keeps inline code content for speech while still dropping fenced code blocks', async () => {
    const svc = setup();

    const text =
      'Run `npm install` before you start and make sure the lockfile is up to date first. ' +
      '```ts\nconst x = 1;\n``` ' +
      'Then call `main()` when ready so the process actually boots correctly afterward. ';
    svc.feedStreamingAssistantText(text, 'af_heart', 1);
    await svc.flushStreamingAssistantText(text, 'af_heart', 1);

    const spoken = queuedText(svc);
    expect(spoken).toContain('npm install');
    expect(spoken).toContain('main()');
    expect(spoken).not.toContain('`');
    expect(spoken).not.toContain('const x = 1');
  });

  it('resets commit tracking when raw primary text shrinks (new assistant turn)', () => {
    const svc = setup();
    const state = internals(svc);

    const long =
      'Long assistant reply here with enough characters to cross the streaming flush minimum. ' +
      'A second sentence makes the buffered length safely exceed the threshold. ';
    svc.feedStreamingAssistantText(long, 'af_heart', 1);
    expect(state.streamingCommittedCleanLen).toBeGreaterThan(0);

    const short =
      'Short replacement turn that is also long enough to flush as its own spoken segment. ' +
      'Another sentence keeps this above the streaming flush minimum too. ';
    svc.feedStreamingAssistantText(short, 'af_heart', 1);

    expect(state.streamingCommittedCleanLen).toBeLessThan(long.length);
    expect(queuedText(svc)).toContain('Short replacement');
    expect(queuedText(svc)).not.toContain('Long assistant reply');
  });

  it('does not re-queue already-spoken text when final_text diverges after partial speak', async () => {
    const svc = setup();
    const state = internals(svc);

    const spoken =
      'This opening paragraph was already spoken aloud during the stream and must not repeat. ';
    const more =
      'A second paragraph continues the streamed reply with enough length for a flush segment. ';
    svc.feedStreamingAssistantText(`${spoken}${more}`, 'af_heart', 1);
    expect(state.streamingSegmentQueue.length).toBeGreaterThan(0);

    // Simulate dequeuing the first segment for synthesis (spoken watermark advances).
    const first = state.takeNextStreamingBatch();
    expect(first).toBeTruthy();
    expect(state.streamingSpokenCleanLen).toBeGreaterThan(0);
    const spokenWatermark = state.streamingSpokenCleanLen;

    const divergentFinal =
      'Completely rewritten final reply that shares almost nothing with the streamed text. ' +
      'It is long enough that a naive flush would otherwise re-speak everything from the start. ';
    await svc.flushStreamingAssistantText(divergentFinal, 'af_heart', 1);

    const queued = queuedText(svc);
    expect(queued).not.toContain('Completely rewritten final reply');
    expect(state.streamingSpokenCleanLen).toBe(spokenWatermark);
    // Remaining uncommitted streamed tail may still be queued; already-spoken opening must not reappear.
    const openingRequeued = state.streamingSegmentQueue.some((s) =>
      s.text.includes('already spoken aloud'),
    );
    expect(openingRequeued).toBe(false);
  });

  it('strips [[tts_mood: ...]] and records turn instructions', () => {
    const svc = setup();
    const state = internals(svc);
    svc.setTtsDefaultInstructions('neutral baseline');

    const clean = state.stripForTts(
      '[[tts_mood: warm, calm]] Hello there, this is a spoken sentence for the voice pipeline.',
    );
    expect(clean).not.toContain('tts_mood');
    expect(clean).toContain('Hello there');
    expect(state.streamingTurnInstructions).toBe('warm, calm');
  });

  it('openai-compatible buffers until flush then queues one single utterance', async () => {
    const svc = setup();
    svc.setTtsChunkProfile('openai-compatible');
    const state = internals(svc);

    const part1 =
      'First sentence of a remote TTS reply should stay buffered until the turn finishes. ';
    const part2 =
      'Second sentence continues afterward and must ride in the same one-shot TTS request. ';
    svc.feedStreamingAssistantText(part1, 'Ryan', 1);
    expect(queuedText(svc)).toBe('');
    expect(state.streamingCleanSnapshot).toContain('First sentence');

    svc.feedStreamingAssistantText(`${part1}${part2}`, 'Ryan', 1);
    expect(queuedText(svc)).toBe('');

    await svc.flushStreamingAssistantText(`${part1}${part2}`, 'Ryan', 1);
    expect(state.streamingSegmentQueue.length).toBe(1);
    const spoken = queuedText(svc);
    expect(spoken).toContain('First sentence');
    expect(spoken).toContain('Second sentence');
  });
});
