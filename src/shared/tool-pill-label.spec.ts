import { describe, expect, it } from 'vitest';
import type { StreamPart } from './types/conversation';
import { toolTrailStatusStreamTag } from './stream-parts';
import {
  formatThoughtDuration,
  formatToolDuration,
  humanizeToolName,
  runCommandIdFromReport,
  toolPillSlowestMs,
  toolPillGroupLabel,
  toolPillLabel,
  toolPillMeta,
  toolPillsGroupTogether,
  toolTargetFromRunningDetail,
} from './tool-pill-label';

function status(label: string, text: string, extra: Partial<StreamPart> = {}): StreamPart {
  return { streamTag: toolTrailStatusStreamTag(`id-${label}`), label, text, toolChainState: 'complete', ...extra };
}

function pill(part: StreamPart, live = false): string {
  const label = toolPillLabel(part, live);
  return [label.verb, toolPillMeta(label)].filter(Boolean).join(' · ');
}

describe('toolPillLabel', () => {
  it('sub-agents: names the sub-agent, not its task', () => {
    const running = status('spawn_subagent', 'Read the README and summarize it', {
      toolChainState: 'running',
      toolSubagentId: 'child-1',
      toolSubagentName: 'Reader',
    });
    expect(pill(running, true)).toBe('Sub-agent · Reader');
  });

  it('a sub-agent spawn cut off by its turn ending reads as kept running (the sub-agent did not stop)', () => {
    const cut = status('spawn_subagent', 'task', {
      toolChainState: 'error',
      toolStopped: true,
      toolSubagentId: 'child-1',
      toolSubagentName: 'long-writer',
    });
    expect(pill(cut)).toBe('Sub-agent · long-writer · kept running');
  });

  it('a call still running when its turn ended reads as stopped', () => {
    const stopped = status('read_workspace_file', 'README.md', { toolChainState: 'error', toolStopped: true, toolTarget: 'README.md' });
    expect(pill(stopped)).toBe('Read · README.md · stopped');
  });

  it('reads: path and line count from the read headline', () => {
    expect(
      pill(status('read_workspace_file', 'File: math_utils.py Encoding: utf-8 Lines: 1-6 (of 6 in file) Format: …')),
    ).toBe('Read · math_utils.py · 6 lines');
    expect(
      pill(status('read_workspace_file', 'File: build_female.py Encoding: utf-8 Lines: 110-135 (of 162 in file)')),
    ).toBe('Read · build_female.py · lines 110–135');
    expect(
      pill(status('read_workspace_image', 'Loaded image: ss.png Type: image/png Size: 723x652 px, 9.8 KB')),
    ).toBe('View image · ss.png · 723×652');
  });

  it('edits: path from backticks and the line delta', () => {
    expect(pill(status('replace_workspace_lines', 'Updated `hello.py` (line-range; 5 → 6 lines). --- Post-edit'))).toBe(
      'Edit · hello.py · 5 → 6 lines',
    );
    expect(
      pill(status('replace_workspace_snippet', 'Auto-applied snippet edit for `src/interaction.ts` (504 diff row(s)')),
    ).toBe('Edit · src/interaction.ts');
    expect(pill(status('write_workspace_file', 'Created `src/Triangle.java` (full-file; 0 → 93 lines). ---'))).toBe(
      'Create · src/Triangle.java · 93 lines',
    );
    expect(pill(status('lsp_update_typescript_file', 'TypeScript/JavaScript LSP workspace path selected for `src/a.ts`.'))).toBe(
      'Write · src/a.ts',
    );
  });

  it('edits with a diff: added / removed line counts', () => {
    const toolDiff = ['@@ -1,2 +1,3 @@', ' a', '-b', '+B', '+c'].join('\n');
    expect(pill(status('replace_workspace_lines', 'Updated `m.py` (line-range; 2 → 3 lines).', { toolDiff }))).toBe(
      'Edit · m.py · +2 −1',
    );
    expect(pill(status('write_workspace_file', 'Created `n.py` (full-file; 0 → 2 lines).', { toolDiff: '+x' }))).toBe(
      'Create · n.py · 2 lines',
    );
  });

  it('prefers the target kept from the running status', () => {
    expect(pill(status('search_workspace', '[src/a.ts line 3] │ foo [src/b.ts line 9] │ foo', { toolTarget: 'foo' }))).toBe(
      'Search · foo · 2 matches',
    );
  });

  it('run_command: command and exit code from the report', () => {
    expect(
      pill(status('run_command', "Command report: - Command id: `6514a07e` - Command: `cmd /c build.bat` - Working directory: `.` - Status: exited with code 1 after 0s")),
    ).toBe('Run · cmd /c build.bat · exit 1');
    expect(pill(status('run_command', "Pending user confirmation for 'run_command'. The UI will ask"))).toBe(
      'Run · awaiting approval',
    );
  });

  it('answered approval cards: cancelled and denied calls say so', () => {
    expect(pill(status('fetch_url', 'User cancelled the pending command: Fetch URL.', { toolTarget: 'https://example.com' }))).toBe(
      'Fetch · https://example.com · cancelled',
    );
    expect(pill(status('run_command', 'User declined administrator access for this agent.'))).toBe('Run · cancelled');
    expect(pill(status('mcp__s__lookup', 'Tool `lookup` on MCP server `docs` is denied.'))).toBe('Lookup · denied');
  });

  it('run-command lanes: command label and exit code', () => {
    const lane: StreamPart = { streamTag: 'run-command:6514a07e', label: 'python hello.py', text: 'Hello world\r\n', runComplete: true, exitCode: 0 };
    expect(pill(lane)).toBe('Run · python hello.py · exit 0');
    expect(pill({ ...lane, runComplete: false, exitCode: undefined }, true)).toBe('Run · python hello.py · running');
  });

  it('lsp diagnostics: issue count', () => {
    expect(pill(status('lsp_get_diagnostics', 'LSP context: … LSP diagnostics for `src/x.ts` (7 issue(s)): - 503:1'))).toBe(
      'Diagnostics · src/x.ts · 7 issues',
    );
    expect(pill(status('lsp_get_diagnostics', 'LSP context: … No LSP diagnostics for `src/x.ts`.'))).toBe(
      'Diagnostics · src/x.ts · no issues',
    );
  });

  it('terminal listings are not mistaken for running commands', () => {
    expect(pill(status('check_user_terminals', 'User PTY terminals (1):  1. `pty-1` — status: running (13s)'))).toBe(
      'Check terminals · 1 terminal',
    );
  });

  it('errors show a short message', () => {
    expect(pill(status('wait_for_command', 'Tool error: no background command with id `e73a3f33`.'))).toBe(
      'Wait · no background command with id `e73a3f33`.',
    );
  });

  it('running rows show the target from the live detail', () => {
    expect(pill(status('write_workspace_file', 'src/app.ts · drafting 2.1 KB', { toolChainState: 'running' }), true)).toBe(
      'Write · src/app.ts',
    );
  });

  it('running rows keep showing progress phases after the target', () => {
    expect(
      pill(status('write_workspace_file', 'Formatting with Prettier', { toolChainState: 'running', toolTarget: 'src/app.ts' }), true),
    ).toBe('Write · src/app.ts · Formatting with Prettier');
    expect(pill(status('write_workspace_file', 'src/app.ts · drafting 2.1 KB', { toolChainState: 'running', toolTarget: 'src/app.ts' }), true)).toBe(
      'Write · src/app.ts',
    );
  });

  it('a wait that timed out reads as still running', () => {
    expect(
      pill(status('wait_for_command', 'Command report: - Command id: `ab12` - Command: `npm test` - Working directory: `.` - Status: still running after 30s (waited 30s this call)')),
    ).toBe('Wait · npm test · running');
  });

  it('unknown tools get a humanized name and an excerpt', () => {
    expect(pill(status('mcp__abc__get_addon_status', 'Error checking addon status: Could not connect.'))).toBe(
      'Get addon status · Error checking addon status: Could not connect.',
    );
  });
});

describe('toolTargetFromRunningDetail', () => {
  it('drops the drafting size suffix', () => {
    expect(toolTargetFromRunningDetail('src/app.ts · drafting 2.1 KB')).toBe('src/app.ts');
    expect(toolTargetFromRunningDetail('drafting 800 chars')).toBe('');
    expect(toolTargetFromRunningDetail('lighting.sample')).toBe('lighting.sample');
  });
});

describe('runCommandIdFromReport', () => {
  it('reads the command id', () => {
    expect(runCommandIdFromReport('Command report: - Command id: `6514a07e` - Command: `x`')).toBe('6514a07e');
    expect(runCommandIdFromReport('Pending user confirmation')).toBeNull();
  });
});

describe('humanizeToolName', () => {
  it('turns snake_case into a sentence and keeps prose labels', () => {
    expect(humanizeToolName('plan_discovery')).toBe('Plan discovery');
    expect(humanizeToolName('Rewriting plan')).toBe('Rewriting plan');
  });
});

describe('grouping', () => {
  const read = (path: string) => toolPillLabel(status('read_workspace_file', `File: ${path} Encoding: utf-8 Lines: 1-3 (of 3 in file)`));
  const edit = toolPillLabel(status('replace_workspace_lines', 'Updated `a.py` (line-range; 1 → 2 lines).'));

  it('groups same-kind calls only', () => {
    expect(toolPillsGroupTogether(read('a.py'), read('b.py'))).toBe(true);
    expect(toolPillsGroupTogether(read('a.py'), edit)).toBe(false);
    const theme = toolPillLabel(status('propose_theme', 'Proposed theme "X" (dark'));
    const plan = toolPillLabel(status('read_build_plan', '# Build Plan: Y'));
    expect(toolPillsGroupTogether(theme, plan)).toBe(false);
    expect(toolPillsGroupTogether(theme, theme)).toBe(true);
  });

  it('summarizes count and distinct short targets', () => {
    expect(toolPillGroupLabel([read('src/a.py'), read('lib/b.py'), read('src/a.py')])).toEqual({
      verb: 'Read',
      meta: '3 files · a.py, b.py',
    });
    expect(toolPillGroupLabel([edit, edit])).toEqual({ verb: 'Edit', meta: '2 edits · a.py' });
  });

  it('groups back-to-back lookups of different kinds into one Explore pill', () => {
    const search = toolPillLabel(status('search_workspace', 'Found 3 matches for "foo"'));
    const list = toolPillLabel(status('list_workspace_directory', 'Directory: src'));
    expect(toolPillsGroupTogether(read('a.py'), search)).toBe(true);
    expect(toolPillsGroupTogether(search, list)).toBe(true);
    expect(toolPillsGroupTogether(search, edit)).toBe(false);
    const label = toolPillGroupLabel([read('src/a.py'), search, read('b.py')]);
    expect(label.verb).toBe('Explore');
    expect(label.meta.startsWith('2 files, 1 search')).toBe(true);
  });
});

describe('tool call durations', () => {
  it('formats run times compactly', () => {
    expect(formatToolDuration(0)).toBe('<1ms');
    expect(formatToolDuration(0.4)).toBe('<1ms');
    expect(formatToolDuration(8.4)).toBe('8ms');
    expect(formatToolDuration(999)).toBe('999ms');
    expect(formatToolDuration(1000)).toBe('1.0s');
    expect(formatToolDuration(1299)).toBe('1.2s');
    expect(formatToolDuration(9999)).toBe('9.9s');
    expect(formatToolDuration(12_400)).toBe('12s');
    expect(formatToolDuration(65_000)).toBe('1m 05s');
    expect(formatToolDuration(3_725_000)).toBe('1h 02m');
  });

  it('formats thinking time in whole seconds', () => {
    expect(formatThoughtDuration(0)).toBe('<1s');
    expect(formatThoughtDuration(999)).toBe('<1s');
    expect(formatThoughtDuration(1000)).toBe('1s');
    expect(formatThoughtDuration(7_900)).toBe('7s');
    expect(formatThoughtDuration(59_999)).toBe('59s');
    expect(formatThoughtDuration(64_000)).toBe('1m 04s');
  });

  it('picks the slowest timed call of a group', () => {
    expect(toolPillSlowestMs([{ toolDurationMs: 40 }, {}, { toolDurationMs: 1200 }])).toBe(1200);
    expect(toolPillSlowestMs([{}, {}])).toBeUndefined();
  });
});
