import type { StreamPart, TurnFeedItem } from '@shared/index';
import { toolTrailStatusStreamTag } from '@shared/index';
import { inFlightToolSpinnerKind, resolveTurnActivity, turnActivitySpinnerKind } from './chat-box-display';
import { toolSpinnerKind } from './tool-spinner-kind';

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
  const base = { primaryLiveText: '', toolsActive: false, toolKind: null, awaitingReview: false };

  it('is prefill before the first stream item', () => {
    expect(resolveTurnActivity({ ...base, feed: [] })).toBe('prefill');
  });

  it('is think while reasoning is the latest event and no tool runs', () => {
    expect(resolveTurnActivity({ ...base, feed: [thought] })).toBe('think');
  });

  it('picks the running tool kind while tools are active', () => {
    expect(resolveTurnActivity({ ...base, feed: [thought, tool], toolsActive: true })).toBe('write');
    for (const toolKind of ['read', 'write', 'run', 'web'] as const) {
      expect(resolveTurnActivity({ ...base, feed: [thought, tool], toolsActive: true, toolKind })).toBe(toolKind);
    }
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

describe('inFlightToolSpinnerKind', () => {
  const running = (label: string): StreamPart => ({
    streamTag: toolTrailStatusStreamTag(label),
    label,
    text: '',
    toolChainState: 'running',
  });

  it('follows the latest running tool', () => {
    expect(inFlightToolSpinnerKind([running('stage_create_file'), running('read_workspace_file')], true)).toBe('read');
    expect(inFlightToolSpinnerKind([running('read_workspace_file'), running('stage_create_file')], true)).toBe('write');
    expect(inFlightToolSpinnerKind([running('read_workspace_file'), running('run_command')], true)).toBe('run');
    expect(inFlightToolSpinnerKind([running('fetch_url')], true)).toBe('web');
  });

  it('is null when tools are not active', () => {
    expect(inFlightToolSpinnerKind([running('read_workspace_file')], false)).toBeNull();
  });
});

describe('toolSpinnerKind', () => {
  it('classifies tools by name and stream tag', () => {
    expect(toolSpinnerKind('search_workspace', '')).toBe('read');
    expect(toolSpinnerKind('wait_for_command', '')).toBe('run');
    expect(toolSpinnerKind('anything', 'run-command:abc')).toBe('run');
    expect(toolSpinnerKind('web_search', '')).toBe('web');
    expect(toolSpinnerKind('fetch_url', '')).toBe('web');
    expect(toolSpinnerKind('replace_workspace_snippet', '')).toBe('write');
  });
});

describe('turnActivitySpinnerKind', () => {
  it('maps each spinning activity to its spinner, and shows none while replying or awaiting review', () => {
    for (const kind of ['prefill', 'think', 'read', 'write', 'run', 'web'] as const) {
      expect(turnActivitySpinnerKind(kind)).toBe(kind);
    }
    expect(turnActivitySpinnerKind('reply')).toBeNull();
    expect(turnActivitySpinnerKind('review')).toBeNull();
  });
});
