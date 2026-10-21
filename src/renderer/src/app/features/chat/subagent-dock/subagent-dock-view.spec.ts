import { describe, expect, it } from 'vitest';
import type { StreamPart } from '@shared/index';
import type { SubagentRun } from '../../shell/conversation-session.service';
import { buildSubagentCardViews } from './subagent-dock-view';

function run(overrides: Partial<SubagentRun> = {}): SubagentRun {
  return {
    conversationId: 'child-1',
    parentConversationId: 'parent',
    name: 'Reader',
    task: 'Read the README\nand summarize it',
    startedAt: 10_000,
    ...overrides,
  };
}

describe('buildSubagentCardViews', () => {
  it('shows a running sub-agent with its current tool call and elapsed time', () => {
    const parts: StreamPart[] = [
      { streamTag: 'tool-trail:r1', label: 'read_workspace_file', text: 'README.md', toolChainState: 'running', toolTarget: 'README.md' },
    ];
    const [card] = buildSubagentCardViews([run()], () => parts, () => undefined, new Map(), 22_500);

    expect(card).toMatchObject({
      conversationId: 'child-1',
      name: 'Reader',
      task: 'Read the README and summarize it',
      state: 'working',
      stateLabel: 'Working',
      elapsed: '12s',
      live: true,
    });
    expect(card!.activity).toBe('Read · README.md');
  });

  it('shows the last lines of the reply text so far', () => {
    const parts: StreamPart[] = [{ streamTag: 'agent', label: '', text: 'line one\n\nline two\nline three' }];
    const [card] = buildSubagentCardViews([run()], () => parts, () => undefined, new Map(), 10_000);
    expect(card!.textTail).toBe('line two line three');
  });

  it('flags a sub-agent waiting on an approval card', () => {
    const [card] = buildSubagentCardViews([run()], () => [], () => undefined, new Map([['child-1', ['req-1']]]), 10_000);
    expect(card).toMatchObject({ state: 'review', stateLabel: 'Needs approval' });
  });

  it('freezes the elapsed time and names the outcome once it ended', () => {
    const cards = buildSubagentCardViews(
      [
        run({ outcome: 'completed', endedAt: 15_000 }),
        run({ conversationId: 'child-2', outcome: 'aborted', endedAt: 11_000 }),
        run({ conversationId: 'child-3', outcome: 'error', endedAt: 10_500 }),
      ],
      () => [],
      () => undefined,
      new Map([['child-1', ['req-1']]]),
      99_000,
    );
    expect(cards.map((c) => [c.state, c.elapsed, c.live])).toEqual([
      ['done', '5.0s', false],
      ['stopped', '1.0s', false],
      ['failed', '500ms', false],
    ]);
  });
});
