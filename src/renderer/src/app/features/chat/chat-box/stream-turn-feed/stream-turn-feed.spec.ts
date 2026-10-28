import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { toolTrailStatusStreamTag, type ChatThinkingDisplay, type TurnFeedItem } from '@shared/index';
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

function render(items: TurnFeedItem[], thinkingDisplay: ChatThinkingDisplay): HTMLElement {
  const fixture = TestBed.createComponent(StreamTurnFeedComponent);
  fixture.componentRef.setInput('items', items);
  fixture.componentRef.setInput('live', true);
  fixture.componentRef.setInput('spinnerActive', true);
  fixture.componentRef.setInput('thinkingDisplay', thinkingDisplay);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

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
    expect(block?.querySelector('.stream-tool-pill__meta')?.textContent).toMatch(/Thinking.*<1s/);
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
