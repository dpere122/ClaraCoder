import { describe, expect, it } from 'vitest';
import { hitlTrailStreamTag, toolTrailStatusStreamTag, type StreamPart, type TurnFeedItem } from '@shared/index';
import { activityLayout, activitySummary } from './activity-blocks';
import type { FeedDisplayRole } from './stream-preview-queue';
import { toolChipLayout } from './tool-chip-groups';

let seq = 0;
function tool(label: string, text: string, extra: Partial<StreamPart> = {}): TurnFeedItem {
  seq += 1;
  return {
    kind: 'tool',
    part: { streamTag: toolTrailStatusStreamTag(`run-${seq}`), label, text, toolChainState: 'complete', ...extra },
  };
}

const read = (path: string, extra: Partial<StreamPart> = {}) =>
  tool('read_workspace_file', `File: ${path} Encoding: utf-8 Lines: 1-3 (of 3 in file)`, extra);
const edit = (path: string, extra: Partial<StreamPart> = {}) =>
  tool('replace_workspace_lines', `Updated \`${path}\` (line-range; 1 → 2 lines).`, extra);
const thought = (ms?: number): TurnFeedItem => ({
  kind: 'thought',
  part: { streamTag: 'reasoning', label: 'Model reasoning', text: 'hmm', thoughtDurationMs: ms },
});
const md = (text = 'Done.'): TurnFeedItem => ({ kind: 'markdown', text });
const hitl: TurnFeedItem = {
  kind: 'tool',
  part: { streamTag: hitlTrailStreamTag('c-1'), label: 'Run terminal command', text: 'approve ok' },
};

/** Chips for everything but markdown (a finished or persisted feed). */
const rolesOf =
  (items: readonly TurnFeedItem[], overrides: Record<number, FeedDisplayRole> = {}) =>
  (index: number): FeedDisplayRole =>
    overrides[index] ?? (items[index]!.kind === 'markdown' ? 'markdown' : 'chip');

function layout(items: TurnFeedItem[], live = false, overrides: Record<number, FeedDisplayRole> = {}) {
  const roleOf = rolesOf(items, overrides);
  return activityLayout(items, roleOf, live, toolChipLayout(items, roleOf, live).hidden);
}

describe('activityLayout', () => {
  it('wraps each stretch between prose in one block, keeping execution order', () => {
    const items = [thought(), read('a.py'), edit('a.py'), md('Fixed it.'), thought(), read('b.py'), md()];
    const out = layout(items);
    expect([...out.blocks.entries()]).toEqual([
      [0, [0, 1, 2]],
      [4, [4, 5]],
    ]);
    expect([...out.hidden].sort()).toEqual([1, 2, 5]);
    expect(out.working.size).toBe(0);
  });

  it('wraps a stretch with a single pill too, so the block never appears or vanishes mid-stretch', () => {
    expect(layout([thought(), md()]).blocks.get(0)).toEqual([0]);
    expect(layout([read('a.py'), read('b.py'), md()]).blocks.get(0)).toEqual([0, 1]);
  });

  it('keeps HITL rows in the open and splits stretches around them', () => {
    const items = [thought(), read('a.py'), hitl, edit('a.py'), thought(), md()];
    const out = layout(items);
    expect([...out.blocks.entries()]).toEqual([
      [0, [0, 1]],
      [3, [3, 4]],
    ]);
    expect(out.hidden.has(2)).toBe(false);
  });

  it('live: the block starts with the first row and is working until prose follows', () => {
    expect(layout([thought()], true, { 0: 'preview' }).blocks.get(0)).toEqual([0]);
    const working = [thought(), read('a.py'), edit('a.py')];
    const out = layout(working, true, { 2: 'preview' });
    expect(out.blocks.get(0)).toEqual([0, 1, 2]);
    expect(out.working.has(0)).toBe(true);
    const done = layout([...working, md('Now ')], true);
    expect(done.blocks.get(0)).toEqual([0, 1, 2]);
    expect(done.working.size).toBe(0);
    // A sentence continuation pulled back above the tools leaves an empty block: still prose.
    expect(layout([...working, md('')], true).working.size).toBe(0);
  });

  it('live: queued rows join the block of the preview ahead of them', () => {
    const items = [thought(), read('a.py'), edit('b.py')];
    expect(layout(items, true, { 1: 'preview', 2: 'hidden' }).blocks.get(0)).toEqual([0, 1, 2]);
  });

  it('live: a stretch with nothing on screen yet gets no block', () => {
    const items = [thought(), hitl, read('a.py')];
    const out = layout(items, true, { 0: 'preview', 1: 'hidden', 2: 'hidden' });
    expect([...out.blocks.keys()]).toEqual([0]);
    expect(out.hidden.has(2)).toBe(false);
  });

  it('live: a stretch before a HITL row keeps working until prose follows', () => {
    const out = layout([thought(), read('a.py'), hitl], true);
    expect(out.working.has(0)).toBe(true);
    expect(layout([thought(), read('a.py'), hitl, md()], true).working.size).toBe(0);
  });
});

describe('activitySummary', () => {
  it('counts thoughts and tools and sums thinking plus tool time', () => {
    const items = [thought(4_000), read('a.py', { toolDurationMs: 1_000 }), edit('a.py', { toolDurationMs: 2_000 })];
    expect(activitySummary(items, [0, 1, 2], new Set())).toEqual({
      headline: 'Read a.py, edited a.py',
      outcomes: '',
      title: 'Read a.py\nEdited a.py\n1 thought, 2 tools',
      duration: '7s',
      failed: false,
    });
  });

  it('names what the stretch did, or Thought for thinking alone', () => {
    const items = [read('a.py'), read('b.py'), edit('a.py'), thought()];
    expect(activitySummary(items, [0, 1, 2], new Set()).headline).toBe('Read 2 files, edited a.py');
    expect(activitySummary(items, [3], new Set()).headline).toBe('Thought');
    expect(activitySummary(items, [], new Set()).headline).toBe('');
  });

  it('counts parallel calls from one step by their slowest', () => {
    const items = [
      read('a.py', { toolBatch: 's1', toolDurationMs: 3_000 }),
      read('b.py', { toolBatch: 's1', toolDurationMs: 5_000 }),
      edit('a.py', { toolBatch: 's2', toolDurationMs: 1_000 }),
    ];
    expect(activitySummary(items, [0, 1, 2], new Set()).duration).toBe('6s');
  });

  it('reports failures and skips merged duplicate rows', () => {
    const items = [thought(), tool('run_command', 'Tool error: boom', { toolChainState: 'error' }), read('a.py')];
    expect(activitySummary(items, [0, 1, 2], new Set([2]))).toEqual({
      headline: 'Ran 1 command',
      outcomes: '1 failed',
      title: 'Ran 1 command\n1 thought, 1 tool',
      duration: '',
      failed: true,
    });
  });
});
