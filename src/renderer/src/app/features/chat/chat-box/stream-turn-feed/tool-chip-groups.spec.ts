import { describe, expect, it } from 'vitest';
import { hitlTrailStreamTag, toolTrailStatusStreamTag, type TurnFeedItem } from '@shared/index';
import { settlingChipIndices, toolChipGroupParts, toolChipLayout } from './tool-chip-groups';

let seq = 0;
function tool(label: string, text: string): TurnFeedItem {
  seq += 1;
  return {
    kind: 'tool',
    part: { streamTag: toolTrailStatusStreamTag(`run-${seq}`), label, text, toolChainState: 'complete' },
  };
}

const read = (path: string) => tool('read_workspace_file', `File: ${path} Encoding: utf-8 Lines: 1-3 (of 3 in file)`);
const edit = (path: string) => tool('replace_workspace_lines', `Updated \`${path}\` (line-range; 1 → 2 lines).`);
const thought: TurnFeedItem = { kind: 'thought', part: { streamTag: 'reasoning', label: 'Model reasoning', text: 'hmm' } };
const md: TurnFeedItem = { kind: 'markdown', text: 'Done.' };
const hitl: TurnFeedItem = {
  kind: 'tool',
  part: { streamTag: hitlTrailStreamTag('c-1'), label: 'Run terminal command', text: 'approve ok' },
};
const lane = (id: string, cmd: string): TurnFeedItem => ({
  kind: 'tool',
  part: { streamTag: `run-command:${id}`, label: cmd, text: 'ok\n', runComplete: true, exitCode: 0 },
});

const allChips = () => 'chip' as const;
const mergedOf = (items: TurnFeedItem[]) => toolChipLayout(items, allChips).merged;

describe('toolChipLayout', () => {
  it('groups back-to-back same-kind chips', () => {
    const items = [read('a.py'), read('b.py'), read('c.py'), edit('a.py')];
    const layout = toolChipLayout(items, allChips);
    expect([...layout.groups.entries()]).toEqual([[0, [0, 1, 2]]]);
    expect([...layout.hidden].sort()).toEqual([1, 2]);
    expect(toolChipGroupParts(items, layout.groups.get(0)!).map((p) => p.label)).toEqual([
      'read_workspace_file',
      'read_workspace_file',
      'read_workspace_file',
    ]);
  });

  it('groups back-to-back lookups of different kinds (read, search, list) into one pill', () => {
    const search = tool('search_workspace', 'Found 3 matches for "foo"');
    const list = tool('list_workspace_directory', 'Directory: src');
    const items = [read('a.py'), search, list, edit('a.py'), read('b.py')];
    const layout = toolChipLayout(items, allChips);
    expect([...layout.groups.entries()]).toEqual([[0, [0, 1, 2]]]);
  });

  it('a thought, prose or HITL row between calls ends the run', () => {
    const items = [read('a.py'), thought, read('b.py'), md, read('c.py'), hitl, read('d.py')];
    const layout = toolChipLayout(items, (i) => (items[i]!.kind === 'markdown' ? 'markdown' : 'chip'));
    expect(layout.groups.size).toBe(0);
  });

  it('a single call stays a plain pill', () => {
    const layout = toolChipLayout([read('a.py'), edit('a.py'), read('b.py')], allChips);
    expect(layout.groups.size).toBe(0);
    expect(layout.hidden.size).toBe(0);
  });

  it('only chips group (the live preview and hidden inbound rows do not)', () => {
    const items = [read('a.py'), read('b.py'), read('c.py')];
    const layout = toolChipLayout(items, (i) => (i === 0 ? 'chip' : i === 1 ? 'preview' : 'hidden'));
    expect(layout.groups.size).toBe(0);
  });

  it('folds a run_command status row into its output lane and keeps grouping across it', () => {
    const status = tool('run_command', 'Command report: - Command id: `abc` - Command: `npm test` - Status: exited with code 0');
    const status2 = tool('run_command', 'Command report: - Command id: `def` - Command: `npm run build`');
    const items = [status, lane('abc', 'npm test'), status2, lane('def', 'npm run build')];
    const layout = toolChipLayout(items, allChips);
    expect([...layout.groups.entries()]).toEqual([[1, [1, 3]]]);
    expect([...layout.hidden].sort()).toEqual([0, 2, 3]);
  });
});

describe('merged run_command status rows', () => {
  it('pairs a pending approval row (no id yet) with the next output lane', () => {
    const pending = tool('run_command', "Pending user confirmation for 'run_command'.");
    expect([...mergedOf([pending, hitl, lane('x1', 'python hello.py')])]).toEqual([0]);
  });

  it('leaves a status row with no lane (blocked or rejected command)', () => {
    const blocked = tool('run_command', 'Tool error: command blocked by safety policy');
    expect(mergedOf([blocked]).size).toBe(0);
  });

  it('does not pair a failed row (no id) with a later call lane', () => {
    const blocked = tool('run_command', 'Tool error: command blocked by safety policy');
    const ok = tool('run_command', 'Command report: - Command id: `zz` - Command: `npm test`');
    expect([...mergedOf([blocked, ok, lane('zz', 'npm test'), lane('other', 'npm run x')])]).toEqual([1]);
  });
});

describe('a declined call and a finished lane that printed nothing', () => {
  const quiet = (id: string): TurnFeedItem => ({
    kind: 'tool',
    part: { streamTag: `run-command:${id}`, label: 'mkdir out', text: '', runComplete: true, exitCode: 0 },
  });

  it('does not pair a declined row (no id) with a later lane', () => {
    const declined = tool('run_command', 'User cancelled the pending command: Run terminal command.');
    expect(toolChipLayout([declined, lane('zz', 'npm test')], allChips).merged.size).toBe(0);
  });

  it('hides the lane and leaves its status row to show the result', () => {
    const status = tool('run_command', 'Command report: - Command id: `zz` - Command: `mkdir out`');
    const layout = toolChipLayout([status, quiet('zz')], allChips);
    expect(layout.merged.size).toBe(0);
    expect([...layout.hidden]).toEqual([1]);
    expect(layout.timedLanes.size).toBe(0);
  });

  it('leaves the lane to the preview until it lands', () => {
    const roles = (index: number) => (index === 1 ? 'preview' : 'chip') as 'preview' | 'chip';
    expect(toolChipLayout([read('a.py'), quiet('zz')], roles).hidden.size).toBe(0);
  });

  it('does not let the hidden lane break a group', () => {
    const layout = toolChipLayout([read('a.py'), quiet('zz'), read('b.py')], allChips);
    expect([...layout.groups.entries()]).toEqual([[0, [0, 2]]]);
  });
});

describe('timedLanes', () => {
  const call = (id: string, ms: number, extra: object = {}): TurnFeedItem => ({
    kind: 'tool',
    part: { streamTag: toolTrailStatusStreamTag(`call-${id}`), label: 'run_command', text: `Command id: \`${id}\``, toolChainState: 'complete', toolDurationMs: ms, toolBatch: id, ...extra },
  });
  const finishedLane = (id: string, runComplete = true): TurnFeedItem => ({
    kind: 'tool',
    part: { streamTag: `run-command:${id}`, label: 'npm test', text: 'ok', runComplete },
  });
  const layoutOf = (items: TurnFeedItem[]) => toolChipLayout(items, () => 'chip', false);

  it('gives a finished lane its status row time and step, without touching the feed item', () => {
    const items = [call('a', 20_000), finishedLane('a')];
    const layout = layoutOf(items);
    expect(layout.timedLanes.get(1)).toMatchObject({ toolDurationMs: 20_000, toolBatch: 'a', text: 'ok' });
    expect(items[1]!.kind === 'tool' && items[1]!.part.toolDurationMs).toBeUndefined();
  });

  it('leaves out a lane whose status row only timed the wait: the command ran on after it', () => {
    const waited = 'Command report: - Command id: `a` - Status: still running after 30s (waited 30s this call)';
    expect(layoutOf([call('a', 30_000, { text: waited }), finishedLane('a')]).timedLanes.size).toBe(0);
  });

  it('keeps the same timed copy while the lane and its time stay the same', () => {
    const items = [call('a', 20_000), finishedLane('a')];
    expect(layoutOf(items).timedLanes.get(1)).toBe(layoutOf(items).timedLanes.get(1));
    const later = [call('a', 25_000), items[1]!];
    expect(layoutOf(later).timedLanes.get(1)).toMatchObject({ toolDurationMs: 25_000 });
  });

  it('feeds lane times to a group', () => {
    const items = [call('a', 20_000), finishedLane('a'), call('b', 12_000), finishedLane('b')];
    const layout = layoutOf(items);
    const parts = toolChipGroupParts(items, [1, 3], layout.timedLanes);
    expect(parts.map((part) => part.toolDurationMs)).toEqual([20_000, 12_000]);
  });

  it('leaves out a lane still running, and a call with no time', () => {
    expect(layoutOf([call('a', 45_000), finishedLane('a', false)]).timedLanes.size).toBe(0);
    expect(layoutOf([call('a', 0, { toolDurationMs: undefined }), finishedLane('a')]).timedLanes.size).toBe(0);
  });
});

describe('settlingChipIndices', () => {
  it('is empty when nothing just committed', () => {
    expect(settlingChipIndices(new Set(), new Map()).size).toBe(0);
  });

  it('marks the chips that just left the preview, and the group pill that took one in', () => {
    const items = [thought, read('a.py'), read('b.py'), edit('a.py'), md];
    const layout = toolChipLayout(items, allChips);
    expect([...settlingChipIndices(new Set([2, 3]), layout.groups)].sort()).toEqual([1, 2, 3]);
  });

  it('leaves earlier chips alone', () => {
    expect([...settlingChipIndices(new Set([2]), new Map())]).toEqual([2]);
  });
});
