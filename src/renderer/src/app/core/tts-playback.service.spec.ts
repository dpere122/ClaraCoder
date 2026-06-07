import { NgZone } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { describe, expect, it } from 'vitest';
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

function internals(svc: TtsPlaybackService): {
  streamingCommittedCleanLen: number;
  streamingSegmentQueue: string[];
} {
  return svc as unknown as {
    streamingCommittedCleanLen: number;
    streamingSegmentQueue: string[];
  };
}

describe('TtsPlaybackService feedStreamingAssistantText', () => {
  it('does not reset committed progress when stripForTts shortens after a code fence closes', () => {
    const { electron } = mockElectron();
    TestBed.configureTestingModule({
      providers: [
        TtsPlaybackService,
        { provide: ElectronService, useValue: electron },
        { provide: NgZone, useValue: new NgZone({}) },
      ],
    });
    const svc = TestBed.inject(TtsPlaybackService);
    const state = internals(svc);

    const intro =
      'This is the opening sentence before any code appears in the reply. ' +
      'It needs to be long enough to pass the streaming flush threshold. ';
    svc.feedStreamingAssistantText(`${intro}\`\`\`python\nx`, 'af_heart', 1);
    const committedAfterIntro = state.streamingCommittedCleanLen;
    expect(committedAfterIntro).toBeGreaterThan(0);
    expect(state.streamingSegmentQueue.join(' ')).toContain('opening sentence');

    svc.feedStreamingAssistantText(`${intro}\`\`\`python\nx\n\`\`\` More text follows.`, 'af_heart', 1);

    expect(state.streamingCommittedCleanLen).toBeGreaterThanOrEqual(committedAfterIntro);
    expect(state.streamingSegmentQueue.join(' ')).toContain('More text follows');
    expect(state.streamingSegmentQueue.join(' ')).not.toContain('opening sentence');
  });

  it('resets commit tracking when raw primary text shrinks (new assistant turn)', () => {
    const { electron } = mockElectron();
    TestBed.configureTestingModule({
      providers: [
        TtsPlaybackService,
        { provide: ElectronService, useValue: electron },
        { provide: NgZone, useValue: new NgZone({}) },
      ],
    });
    const svc = TestBed.inject(TtsPlaybackService);
    const state = internals(svc);

    svc.feedStreamingAssistantText('Long assistant reply here.', 'af_heart', 1);
    expect(state.streamingCommittedCleanLen).toBeGreaterThan(0);

    svc.feedStreamingAssistantText('Short.', 'af_heart', 1);

    expect(state.streamingCommittedCleanLen).toBeLessThan('Long assistant reply here.'.length);
    expect(state.streamingSegmentQueue.join(' ')).toContain('Short');
  });
});
