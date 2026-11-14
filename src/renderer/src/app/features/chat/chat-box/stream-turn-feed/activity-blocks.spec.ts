import { describe, expect, it } from 'vitest';
import { hitlTrailStreamTag, toolTrailStatusStreamTag, type StreamPart, type TurnFeedItem } from '@shared/index';
import { activityLayout, activitySummary, turnWorkLayout } from './activity-blocks';
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

describe('activitySummary declined calls', () => {
  it('notes declined calls beside the headline, and says nothing about approved ones', () => {
    const items = [
      tool('run_command', 'Command id: `a` Exit code: 0', { toolTarget: 'a' }),
      tool('run_command', 'User cancelled the pending command: Run terminal command.', { toolTarget: 'c' }),
    ];
    expect(activitySummary(items, [0, 1], new Set()).outcomes).toBe('1 declined');
    expect(activitySummary(items, [0], new Set()).outcomes).toBe('');
  });

  it('does not count a declined call as run', () => {
    const ran = (id: string) => tool('run_command', `Command id: \`${id}\` Exit code: 0`, { toolTarget: id });
    const refused = (id: string) => tool('run_command', 'User cancelled the pending command: Run terminal command.', { toolTarget: id });
    expect(activitySummary([ran('a'), refused('b'), ran('c')], [0, 1, 2], new Set())).toMatchObject({
      headline: 'Ran 2 commands',
      outcomes: '1 declined',
    });
  });

  it('names the decline in the headline alone when nothing ran', () => {
    const refused = tool('run_command', 'User cancelled the pending command: Run terminal command.', { toolTarget: 'npm test' });
    expect(activitySummary([refused], [0], new Set())).toMatchObject({ headline: 'Declined npm test', outcomes: '' });
  });

  it('does not count an MCP call the user denied as run', () => {
    const denied = tool('mcp__docs__lookup', 'Tool `lookup` on MCP server `docs` is denied.');
    expect(activitySummary([read('a.py'), denied], [0, 1], new Set())).toMatchObject({ headline: 'Read a.py', outcomes: '1 declined' });
    expect(activitySummary([denied], [0], new Set())).toMatchObject({ headline: 'Declined lookup', outcomes: '' });
  });

  it('does not mistake command output for a decline', () => {
    const lane: TurnFeedItem = { kind: 'tool', part: { streamTag: 'run-command:a', label: 'x', text: 'User cancelled the job', runComplete: true } };
    expect(activitySummary([lane], [0], new Set()).outcomes).toBe('');
  });
});

describe('activitySummary command lanes', () => {
  const lane = (text: string, extra: Partial<StreamPart> = {}): TurnFeedItem => ({
    kind: 'tool',
    part: { streamTag: 'run-command:a', label: 'npm run dev', text, ...extra },
  });

  it('counts one command however many rows an older saved turn split its output into', () => {
    const summary = activitySummary([lane('one\n'), read('a.py'), lane('two\n')], [0, 1, 2], new Set());
    expect(summary.headline).toBe('Ran npm run dev, read a.py');
    expect(summary.title).toContain('2 tools');
  });

  it('leaves out a lane that printed nothing: its status row is the call', () => {
    const call = tool('run_command', 'Command report: - Command id: `a` - Command: `mkdir out`', { toolTarget: 'mkdir out' });
    const items = [call, lane('', { label: 'mkdir out', runComplete: true, exitCode: 0 })];
    const summary = activitySummary(items, [0, 1], toolChipLayout(items, rolesOf(items)).merged);
    expect(summary.headline).toBe('Ran mkdir out');
    expect(summary.title).toContain('1 tool');
  });
});

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

describe('turnWorkLayout', () => {
  function work(items: TurnFeedItem[], live = false) {
    const roleOf = rolesOf(items);
    const chipHidden = toolChipLayout(items, roleOf, live).hidden;
    return turnWorkLayout(items, roleOf, live, activityLayout(items, roleOf, live, chipHidden), chipHidden);
  }

  it('folds every stretch and the prose between them, leaving the reply out', () => {
    const items = [thought(), read('a.py'), md('Now the edit.'), edit('a.py'), md('Fixed it.')];
    expect(work(items)).toEqual({ rows: [0, 2, 3], members: [0, 1, 3], reply: 4 });
  });

  it('folds prose written ahead of the first tool', () => {
    expect(work([md('Let me look.'), read('a.py'), md()])).toEqual({ rows: [0, 1], members: [1], reply: 2 });
  });

  it('folds HITL rows with the stretches around them', () => {
    const items = [read('a.py'), hitl, edit('a.py'), md()];
    expect(work(items)).toEqual({ rows: [0, 1, 2], members: [0, 2], reply: 3 });
  });

  it('folds a turn that ended on tools whole: it has no reply', () => {
    const items = [read('a.py'), md('Now the edit.'), edit('a.py')];
    expect(work(items)).toEqual({ rows: [0, 1, 2], members: [0, 2], reply: -1 });
  });

  it('leaves a single stretch alone: its activity block is already one pill', () => {
    expect(work([thought(), read('a.py'), edit('a.py'), md()])).toBeNull();
    expect(work([thought(), read('a.py')])).toBeNull();
    expect(work([md()])).toBeNull();
  });

  it('never folds a live turn', () => {
    expect(work([thought(), read('a.py'), md('Now the edit.'), edit('a.py'), md('Fixed it.')], true)).toBeNull();
  });
});

describe('activitySummary', () => {
  it('sums every stretch of a folded turn into one headline', () => {
    const items = [read('a.py', { toolDurationMs: 1_000 }), md('Now the edit.'), edit('b.py', { toolDurationMs: 2_000 }), md()];
    expect(activitySummary(items, [0, 2], new Set())).toMatchObject({ headline: 'Read a.py, edited b.py', duration: '3s' });
  });

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

  it('counts the run time of a command whose output lane stands in for its call row', () => {
    const call = (id: string, ms: number) => tool('run_command', `Command id: \`${id}\``, { toolBatch: id, toolDurationMs: ms });
    const lane = (id: string): TurnFeedItem => ({
      kind: 'tool',
      part: { streamTag: `run-command:${id}`, label: 'npm test', text: 'ok', runComplete: true, exitCode: 0 },
    });
    const items = [call('a', 20_000), lane('a'), call('b', 12_000)];
    const summary = activitySummary(items, [0, 1, 2], new Set([0]));
    expect(summary.duration).toBe('32s');
    expect(summary.title).toContain('2 tools');
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
