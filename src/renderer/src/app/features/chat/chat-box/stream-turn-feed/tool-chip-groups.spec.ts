import { describe, expect, it } from 'vitest';
import { hitlTrailStreamTag, toolTrailStatusStreamTag, type TurnFeedItem } from '@shared/index';
import { mergedRunCommandStatusIndices, settlingChipIndices, toolChipGroupParts, toolChipLayout } from './tool-chip-groups';

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

describe('mergedRunCommandStatusIndices', () => {
  it('pairs a pending approval row (no id yet) with the next output lane', () => {
    const pending = tool('run_command', "Pending user confirmation for 'run_command'.");
    expect([...mergedRunCommandStatusIndices([pending, hitl, lane('x1', 'python hello.py')])]).toEqual([0]);
  });

  it('leaves a status row with no lane (blocked or rejected command)', () => {
    const blocked = tool('run_command', 'Tool error: command blocked by safety policy');
    expect(mergedRunCommandStatusIndices([blocked]).size).toBe(0);
  });

  it('does not pair a failed row (no id) with a later call lane', () => {
    const blocked = tool('run_command', 'Tool error: command blocked by safety policy');
    const ok = tool('run_command', 'Command report: - Command id: `zz` - Command: `npm test`');
    expect([...mergedRunCommandStatusIndices([blocked, ok, lane('zz', 'npm test'), lane('other', 'npm run x')])]).toEqual([1]);
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
