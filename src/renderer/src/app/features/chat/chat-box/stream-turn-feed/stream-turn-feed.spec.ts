import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { buildTurnFeed, toolTrailStatusStreamTag, type ChatThinkingDisplay, type StreamPart, type TurnFeedItem } from '@shared/index';
import { markToolExecStreamComplete } from '../../../shell/app-stream-parts';
import { StreamTurnFeedComponent } from './stream-turn-feed';

const read: TurnFeedItem = {
  kind: 'tool',
  part: {
    streamTag: toolTrailStatusStreamTag('r1'),
    label: 'read_workspace_file',
    text: 'File: a.py Encoding: utf-8 Lines: 1-3 (of 3 in file)',
    toolChainState: 'complete',
  },
};
const thinking: TurnFeedItem = {
  kind: 'thought',
  part: { streamTag: 'reasoning', label: 'Model reasoning', text: 'Now the second file', thoughtStartedAt: Date.now() },
};
/** Tools from two LLM steps: the search is the open preview, the read has landed. */
const readStep: TurnFeedItem = { kind: 'tool', part: { ...read.part, toolBatch: 'step-1' } } as TurnFeedItem;
const searching: TurnFeedItem = {
  kind: 'tool',
  part: {
    streamTag: toolTrailStatusStreamTag('s1'),
    label: 'search_workspace',
    text: 'foo',
    toolChainState: 'running',
    toolBatch: 'step-2',
  },
};
/** A command's output lane that has opened but printed nothing yet. */
const commandLane: TurnFeedItem = {
  kind: 'tool',
  part: { streamTag: 'run-command:abc12345', label: 'npm test', text: '' },
};

function render(items: TurnFeedItem[], thinkingDisplay: ChatThinkingDisplay): HTMLElement {
  const fixture = TestBed.createComponent(StreamTurnFeedComponent);
  fixture.componentRef.setInput('items', items);
  fixture.componentRef.setInput('live', true);
  fixture.componentRef.setInput('spinnerActive', true);
  fixture.componentRef.setInput('thinkingDisplay', thinkingDisplay);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('StreamTurnFeedComponent folded turn work', () => {
  const edit: TurnFeedItem = {
    kind: 'tool',
    part: {
      streamTag: toolTrailStatusStreamTag('e1'),
      label: 'replace_workspace_lines',
      text: 'Updated `b.py` (line-range; 1 → 2 lines).',
      toolChainState: 'complete',
    },
  };
  const turn: TurnFeedItem[] = [read, { kind: 'markdown', text: 'Now the edit.' }, edit, { kind: 'markdown', text: 'Fixed it.' }];

  function mount(items: TurnFeedItem[], live = false) {
    const fixture = TestBed.createComponent(StreamTurnFeedComponent);
    fixture.componentRef.setInput('items', items);
    fixture.componentRef.setInput('live', live);
    fixture.detectChanges();
    return fixture;
  }

  it('shows a finished turn as one pill and its reply', () => {
    const el = mount(turn).nativeElement as HTMLElement;
    const pills = el.querySelectorAll('app-stream-tool-pill');
    expect(pills.length).toBe(1);
    expect(pills[0]!.querySelector('.stream-tool-pill__name')?.textContent).toContain('Read a.py, edited b.py');
    expect(pills[0]!.querySelectorAll('.stream-tool-pill__icon').length).toBe(2);
    const prose = [...el.querySelectorAll('.stream-turn-feed__markdown')].map((md) => md.textContent?.trim());
    expect(prose).toEqual(['Fixed it.']);
  });

  it('opens to the rows as they streamed, each stretch still its own block', () => {
    const fixture = mount(turn);
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('.stream-turn-feed__work > app-stream-tool-pill button')!.click();
    fixture.detectChanges();
    const body = el.querySelector('.stream-turn-feed__work > .stream-turn-feed__activity-body');
    expect(body?.querySelectorAll(':scope > .stream-turn-feed__activity').length).toBe(2);
    expect(body?.querySelector(':scope > .stream-turn-feed__markdown')?.textContent).toContain('Now the edit.');
    // The reply stays below the pill, outside the opened work.
    expect(el.querySelector('.stream-turn-feed > .stream-turn-feed__markdown')?.textContent).toContain('Fixed it.');
  });

  it('keeps the rows in the open while the turn is live', () => {
    const el = mount(turn, true).nativeElement as HTMLElement;
    expect(el.querySelector('.stream-turn-feed__work')).toBeNull();
    expect(el.querySelectorAll('.stream-turn-feed > .stream-turn-feed__activity').length).toBe(2);
    expect(el.querySelectorAll('.stream-turn-feed > .stream-turn-feed__markdown').length).toBe(2);
  });

  it('does not wrap a turn whose work is a single stretch', () => {
    const el = mount([read, edit, { kind: 'markdown', text: 'Fixed it.' }]).nativeElement as HTMLElement;
    expect(el.querySelector('.stream-turn-feed__work')).toBeNull();
    expect(el.querySelectorAll('.stream-turn-feed > .stream-turn-feed__activity').length).toBe(1);
  });
});

describe('StreamTurnFeedComponent activity blocks', () => {
  it('keeps the streaming reasoning box in view under a closed block (live preview display)', () => {
    const el = render([read, thinking], 'preview');
    const block = el.querySelector('.stream-turn-feed__activity');
    expect(block?.classList.contains('stream-turn-feed__activity--open')).toBe(false);
    expect(block?.querySelector('.stream-turn-feed__activity-body')).toBeNull();
    expect(block?.querySelector('.stream-turn-feed__preview-body')?.textContent).toContain('Now the second file');
    // One spinner: the box header hosts it, not the block pill too.
    expect(block?.querySelectorAll('.stream-turn-feed__preview-spinner').length).toBe(1);
    expect(block?.querySelector('app-stream-tool-pill .stream-tool-pill__spinner')).toBeNull();
  });

  it('folds a compact thinking pill into the closed block pill (compact pill display)', () => {
    const el = render([read, thinking], 'pill');
    const block = el.querySelector('.stream-turn-feed__activity');
    expect(block?.querySelector('.stream-turn-feed__preview')).toBeNull();
    expect(block?.querySelector('.stream-tool-pill__name')?.getAttribute('aria-label')).toBe('Thinking');
    expect(block?.querySelector('.stream-tool-pill__meta')?.textContent).toMatch(/<1s/);
  });

  it('glows the running tool verb in the closed block pill, with what landed beside it', () => {
    const el = render([readStep, searching], 'pill');
    const name = el.querySelector('.stream-turn-feed__activity .stream-tool-pill__name--shimmer');
    expect(name?.getAttribute('aria-label')).toBe('Search');
    expect(name?.querySelectorAll('.processing-text__letter').length).toBe('Search'.length);
    expect(el.textContent).not.toContain('Working');
    expect(el.querySelector('.stream-turn-feed__activity .stream-tool-pill__meta')?.textContent).toContain('Read a.py');
  });

  it('reports the glyph its pill animates, so the conversation list can draw the same one', () => {
    const fixture = TestBed.createComponent(StreamTurnFeedComponent);
    const kinds: (string | null)[] = [];
    const glyphs: (string | null)[] = [];
    fixture.componentInstance.spinnerKindChange.subscribe((kind) => kinds.push(kind));
    fixture.componentInstance.spinnerGlyphChange.subscribe((glyph) => glyphs.push(glyph));
    fixture.componentRef.setInput('items', [readStep, searching]);
    fixture.componentRef.setInput('live', true);
    fixture.componentRef.setInput('spinnerActive', true);
    fixture.componentRef.setInput('thinkingDisplay', 'pill');
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.stream-tool-pill__spinner .ts-sweep')).not.toBeNull();
    expect(glyphs.at(-1)).toBe('search');
    expect(kinds.at(-1)).toBe('read');

    fixture.componentRef.setInput('spinnerActive', false);
    fixture.detectChanges();
    expect(glyphs.at(-1)).toBeNull();
    expect(kinds.at(-1)).toBeNull();
  });

  it('glows Running for an approved command while its card still reads as pending', () => {
    const fixture = TestBed.createComponent(StreamTurnFeedComponent);
    fixture.componentRef.setInput('items', [commandLane]);
    fixture.componentRef.setInput('live', true);
    fixture.componentRef.setInput('spinnerActive', false);
    fixture.detectChanges();
    const name = (fixture.nativeElement as HTMLElement).querySelector('.stream-tool-pill__name--shimmer');
    expect(name?.getAttribute('aria-label')).toBe('Running');
  });

  it('does not glow a preview that is only waiting on an approval card', () => {
    const fixture = TestBed.createComponent(StreamTurnFeedComponent);
    fixture.componentRef.setInput('items', [searching]);
    fixture.componentRef.setInput('live', true);
    fixture.componentRef.setInput('spinnerActive', false);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.stream-tool-pill__name--shimmer')).toBeNull();
  });

  it('leaves the glow to the running row once the block is open', () => {
    const fixture = TestBed.createComponent(StreamTurnFeedComponent);
    fixture.componentRef.setInput('items', [readStep, searching]);
    fixture.componentRef.setInput('live', true);
    fixture.componentRef.setInput('spinnerActive', true);
    fixture.detectChanges();
    fixture.componentInstance.toggleActivity(0, [0, 1]);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const header = el.querySelector('.stream-turn-feed__activity > app-stream-tool-pill');
    expect(header?.querySelector('.stream-tool-pill__name--shimmer')).toBeNull();
    expect(header?.querySelector('.stream-tool-pill__name')?.textContent).toContain('Read a.py');
    const running = el.querySelector('.stream-turn-feed__activity-body .stream-tool-pill__name--shimmer');
    expect(running?.getAttribute('aria-label')).toBe('Search');
  });

  it('keeps the open preview, and the open block, when a quiet command ends behind them', () => {
    const lane = 'run-command:abc12345';
    const parts: StreamPart[] = [
      { streamTag: toolTrailStatusStreamTag('c1'), label: 'run_command', text: 'Command id: `abc12345`', toolChainState: 'complete' },
      { streamTag: lane, label: 'npm run dev', text: '' },
      { streamTag: 'clara', label: '', text: 'Now the search.' },
      thinking.part,
      (searching as Extract<TurnFeedItem, { kind: 'tool' }>).part,
    ];
    const fixture = TestBed.createComponent(StreamTurnFeedComponent);
    fixture.componentRef.setInput('items', buildTurnFeed(parts));
    fixture.componentRef.setInput('live', true);
    fixture.componentRef.setInput('spinnerActive', true);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const blocks = () => el.querySelectorAll('.stream-turn-feed__activity');
    expect(blocks()[1]?.querySelector('.stream-tool-pill__name--shimmer')?.getAttribute('aria-label')).toBe('Search');
    fixture.componentInstance.toggleActivity(3, [3, 4]);
    fixture.detectChanges();
    expect(blocks()[1]?.classList.contains('stream-turn-feed__activity--open')).toBe(true);

    fixture.componentRef.setInput('items', buildTurnFeed(markToolExecStreamComplete(parts, lane, 0)));
    fixture.detectChanges();
    expect(blocks()[1]?.classList.contains('stream-turn-feed__activity--open')).toBe(true);
    expect(blocks()[1]?.querySelector('.stream-tool-pill__name--shimmer')?.getAttribute('aria-label')).toBe('Search');
  });

  it('hides the block pill while the first thought streams in its reasoning box', () => {
    const el = render([thinking], 'preview');
    const block = el.querySelector('.stream-turn-feed__activity');
    expect(block?.querySelector('app-stream-tool-pill')).toBeNull();
    expect(block?.querySelector('.stream-turn-feed__preview-body')?.textContent).toContain('Now the second file');
  });

  it("lines up the still glyphs of the tools a finished, closed block ran", () => {
    const search: TurnFeedItem = {
      kind: 'tool',
      part: { streamTag: toolTrailStatusStreamTag('s1'), label: 'search_workspace', text: '3 matches', toolChainState: 'complete' },
    };
    const reply: TurnFeedItem = { kind: 'markdown', text: 'Done.' };
    const fixture = TestBed.createComponent(StreamTurnFeedComponent);
    fixture.componentRef.setInput('items', [read, search, { ...read, part: { ...read.part, streamTag: toolTrailStatusStreamTag('r2') } }, reply]);
    fixture.detectChanges();
    const pill = (fixture.nativeElement as HTMLElement).querySelector('.stream-turn-feed__activity > app-stream-tool-pill');
    const glyphs = [...(pill?.querySelectorAll('.stream-tool-pill__icon svg') ?? [])];
    expect(glyphs.length).toBe(2);
    expect(glyphs.every((svg) => svg.classList.contains('tool-spinner--still'))).toBe(true);
    expect(glyphs[0]!.querySelector('.ts-wave')).not.toBeNull();
    expect(glyphs[1]!.querySelector('.ts-sweep')).not.toBeNull();
  });
});
