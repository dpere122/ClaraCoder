import type { StreamPart, TurnFeedItem } from '@shared/index';
import { toolTrailStatusStreamTag } from '@shared/index';
import { isReadToolInFlight, resolveTurnActivity, turnActivitySpinnerSrc } from './chat-box-display';

describe('resolveTurnActivity', () => {
  const thought: TurnFeedItem = {
    kind: 'thought',
    part: { streamTag: 'reasoning', label: 'Model reasoning', text: 'hmm' },
  };
  const tool: TurnFeedItem = {
    kind: 'tool',
    part: { streamTag: toolTrailStatusStreamTag('run-1'), label: 'stage_create_file', text: 'src/a.ts' },
  };
  const prose: TurnFeedItem = { kind: 'markdown', text: 'Here is the answer.' };
  const base = { primaryLiveText: '', toolsActive: false, readToolActive: false, awaitingReview: false };

  it('is prefill before the first stream item', () => {
    expect(resolveTurnActivity({ ...base, feed: [] })).toBe('prefill');
  });

  it('is think while reasoning is the latest event and no tool runs', () => {
    expect(resolveTurnActivity({ ...base, feed: [thought] })).toBe('think');
  });

  it('picks read vs write while tools are active', () => {
    expect(resolveTurnActivity({ ...base, feed: [thought, tool], toolsActive: true })).toBe('write');
    expect(
      resolveTurnActivity({ ...base, feed: [thought, tool], toolsActive: true, readToolActive: true }),
    ).toBe('read');
  });

  it('is reply while prose streams, even with a tool still marked active', () => {
    expect(resolveTurnActivity({ ...base, feed: [tool, prose] })).toBe('reply');
    expect(resolveTurnActivity({ ...base, feed: [thought], primaryLiveText: 'partial', toolsActive: true })).toBe(
      'reply',
    );
  });

  it('is review whenever a HITL card blocks the turn', () => {
    expect(resolveTurnActivity({ ...base, feed: [], awaitingReview: true })).toBe('review');
    expect(resolveTurnActivity({ ...base, feed: [tool], toolsActive: true, awaitingReview: true })).toBe('review');
  });
});

describe('isReadToolInFlight', () => {
  const running = (label: string): StreamPart => ({
    streamTag: toolTrailStatusStreamTag(label),
    label,
    text: '',
    toolChainState: 'running',
  });

  it('follows the latest running tool', () => {
    expect(isReadToolInFlight([running('stage_create_file'), running('read_workspace_file')], true)).toBe(true);
    expect(isReadToolInFlight([running('read_workspace_file'), running('stage_create_file')], true)).toBe(false);
  });

  it('is false when tools are not active', () => {
    expect(isReadToolInFlight([running('read_workspace_file')], false)).toBe(false);
  });
});

describe('turnActivitySpinnerSrc', () => {
  it('maps each spinning activity to the live-stream spinner image', () => {
    expect(turnActivitySpinnerSrc('prefill')).toBe('spinner-prefill.svg');
    expect(turnActivitySpinnerSrc('think')).toBe('spinner.svg');
    expect(turnActivitySpinnerSrc('read')).toBe('spinner-read.svg');
    expect(turnActivitySpinnerSrc('write')).toBe('spinner-jot.svg');
    expect(turnActivitySpinnerSrc('reply')).toBeNull();
    expect(turnActivitySpinnerSrc('review')).toBeNull();
  });
});
