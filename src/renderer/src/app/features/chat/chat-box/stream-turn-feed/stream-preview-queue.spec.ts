import { describe, expect, it } from 'vitest';
import { hitlTrailStreamTag, toolTrailStatusStreamTag, type TurnFeedItem } from '@shared/index';
import {
  PREVIEW_IDLE_MS,
  PREVIEW_INBOUND_ANNOUNCE_MS,
  PREVIEW_OPEN_DWELL_MS,
  advanceZeroDwell,
  decidePreviewCommit,
  displayCommittedCount,
  feedItemDisplayRole,
  firstQueueableIdentity,
  hasCommitPressure,
  initialLiveCommittedCount,
  isQueueableFeedItem,
  isToolBatchMember,
  isZeroDwellQueueItem,
  previewCommitCount,
  previewItemLabel,
  previewItemText,
  previewQueueHeader,
  previewShowsBody,
  pressureInbound,
  queueableFeedIdentity,
  splitQueuedFeed,
} from './stream-preview-queue';

const thought: TurnFeedItem = {
  kind: 'thought',
  part: { streamTag: 'reasoning', label: 'Model reasoning', text: 'hmm' },
};
const tool: TurnFeedItem = {
  kind: 'tool',
  part: { streamTag: toolTrailStatusStreamTag('run-1'), label: 'read_workspace_file', text: 'src/a.py' },
};
const tool2: TurnFeedItem = {
  kind: 'tool',
  part: { streamTag: toolTrailStatusStreamTag('run-2'), label: 'search_workspace', text: 'query' },
};
const tool3: TurnFeedItem = {
  kind: 'tool',
  part: { streamTag: toolTrailStatusStreamTag('run-3'), label: 'list_workspace_directory', text: '.' },
};
const brief: TurnFeedItem = {
  kind: 'brief',
  part: { streamTag: 'clara', label: 'Clara', text: 'next I will read' },
};
const nudge: TurnFeedItem = {
  kind: 'nudge',
  part: { streamTag: 'nudge', label: 'Nudge', text: 'almost' },
};
const md: TurnFeedItem = { kind: 'markdown', text: 'Here is the answer.' };
const hitl: TurnFeedItem = {
  kind: 'tool',
  part: { streamTag: hitlTrailStreamTag('change-1'), label: 'edit src/a.ts', text: 'pending' },
};

describe('isQueueableFeedItem', () => {
  it('queues thought, brief, nudge, and tool; not markdown', () => {
    expect(isQueueableFeedItem(thought)).toBe(true);
    expect(isQueueableFeedItem(brief)).toBe(true);
    expect(isQueueableFeedItem(nudge)).toBe(true);
    expect(isQueueableFeedItem(tool)).toBe(true);
    expect(isQueueableFeedItem(hitl)).toBe(true);
    expect(isQueueableFeedItem(md)).toBe(false);
  });
});

describe('isZeroDwellQueueItem', () => {
  it('is true only for HITL trail tools', () => {
    expect(isZeroDwellQueueItem(hitl)).toBe(true);
    expect(isZeroDwellQueueItem(tool)).toBe(false);
    expect(isZeroDwellQueueItem(thought)).toBe(false);
  });
});

describe('isToolBatchMember', () => {
  it('includes ordinary tools and excludes HITL', () => {
    expect(isToolBatchMember(tool)).toBe(true);
    expect(isToolBatchMember(hitl)).toBe(false);
    expect(isToolBatchMember(thought)).toBe(false);
  });
});

describe('previewItemLabel', () => {
  it('uses Thinking without ellipsis for thoughts', () => {
    expect(previewItemLabel(thought)).toBe('Thinking');
  });

  it('uses the tool label', () => {
    expect(previewItemLabel(tool)).toBe('read_workspace_file');
  });
});

describe('previewQueueHeader', () => {
  it('is the current label when nothing is inbound', () => {
    expect(previewQueueHeader(thought, [])).toBe('Thinking');
  });

  it('appends every inbound event with a dash', () => {
    expect(previewQueueHeader(thought, [tool, tool2])).toBe(
      'Thinking — read_workspace_file — search_workspace',
    );
  });
});

describe('previewShowsBody', () => {
  it('is true for thought/brief/nudge and false for tools', () => {
    expect(previewShowsBody(thought)).toBe(true);
    expect(previewShowsBody(brief)).toBe(true);
    expect(previewShowsBody(nudge)).toBe(true);
    expect(previewShowsBody(tool)).toBe(false);
    expect(previewShowsBody(undefined)).toBe(false);
  });
});

describe('splitQueuedFeed', () => {
  it('keeps same-tick thought+tool as current+inbound', () => {
    const split = splitQueuedFeed([thought, tool], 0);
    expect(split.committed).toEqual([]);
    expect(split.current).toEqual(thought);
    expect(split.inbound).toEqual([tool]);
    expect(previewQueueHeader(split.current!, split.inbound)).toBe('Thinking — read_workspace_file');
  });

  it('lists simultaneous tools after the current thought', () => {
    const split = splitQueuedFeed([thought, tool, tool2, tool3], 0);
    expect(split.current).toEqual(thought);
    expect(split.inbound.map(previewItemLabel)).toEqual([
      'read_workspace_file',
      'search_workspace',
      'list_workspace_directory',
    ]);
  });

  it('does not queue markdown', () => {
    const split = splitQueuedFeed([thought, tool, md], 0);
    expect(split.current).toEqual(thought);
    expect(split.inbound).toEqual([tool]);
  });

  it('promotes the tool to current after the thought commits', () => {
    const split = splitQueuedFeed([thought, tool], 1);
    expect(split.committed).toEqual([thought]);
    expect(split.current).toEqual(tool);
    expect(split.inbound).toEqual([]);
  });

  it('treats in-place text growth as the same current identity', () => {
    const grown: TurnFeedItem = {
      kind: 'thought',
      part: { ...thought.part, text: 'hmm more' },
    };
    expect(queueableFeedIdentity(thought)).toBe(queueableFeedIdentity(grown));
    expect(previewItemText(splitQueuedFeed([grown, tool], 0).current!)).toBe('hmm more');
  });
});

describe('previewCommitCount', () => {
  it('commits a thought by itself', () => {
    expect(previewCommitCount([thought, tool, tool2], 0)).toBe(1);
  });

  it('commits simultaneous tools as one batch', () => {
    expect(previewCommitCount([thought, tool, tool2, tool3], 1)).toBe(3);
  });

  it('stops the tool batch before a later thought', () => {
    expect(previewCommitCount([tool, tool2, thought], 0)).toBe(2);
  });

  it('does not batch HITL with ordinary tools', () => {
    expect(previewCommitCount([tool, hitl, tool2], 0)).toBe(1);
  });
});

describe('pressureInbound', () => {
  it('treats the first inbound as pressure on a thought', () => {
    expect(pressureInbound(thought, [tool, tool2])).toEqual(tool);
  });

  it('ignores sibling tools in the live batch', () => {
    expect(pressureInbound(tool, [tool2, tool3])).toBeUndefined();
    expect(pressureInbound(tool, [tool2, thought])).toEqual(thought);
  });
});

describe('feedItemDisplayRole', () => {
  it('shows persisted items as chips', () => {
    expect(feedItemDisplayRole([thought, tool], 0, 0, false)).toBe('chip');
    expect(feedItemDisplayRole([thought, tool], 1, 0, false)).toBe('chip');
  });

  it('hides queued inbound while the current item is previewing', () => {
    const items = [thought, tool, md];
    expect(feedItemDisplayRole(items, 0, 0, true)).toBe('preview');
    expect(feedItemDisplayRole(items, 1, 0, true)).toBe('hidden');
    expect(feedItemDisplayRole(items, 2, 0, true)).toBe('markdown');
  });

  it('hides sibling tools while the batch preview is open', () => {
    const items = [tool, tool2, tool3];
    expect(feedItemDisplayRole(items, 0, 0, true)).toBe('preview');
    expect(feedItemDisplayRole(items, 1, 0, true)).toBe('hidden');
    expect(feedItemDisplayRole(items, 2, 0, true)).toBe('hidden');
  });

  it('renders committed items as chips', () => {
    const items = [thought, tool];
    expect(feedItemDisplayRole(items, 0, 1, true)).toBe('chip');
    expect(feedItemDisplayRole(items, 1, 1, true)).toBe('preview');
  });
});

describe('advanceZeroDwell', () => {
  it('skips HITL so it never occupies the preview slot', () => {
    expect(advanceZeroDwell([hitl, thought], 0)).toBe(1);
    expect(displayCommittedCount([thought, hitl, tool], 1)).toBe(2);
  });
});

describe('initialLiveCommittedCount', () => {
  it('previews a brand-new single event', () => {
    expect(initialLiveCommittedCount([])).toBe(0);
    expect(initialLiveCommittedCount([thought])).toBe(0);
  });

  it('keeps only the current event in preview when remounting mid-turn', () => {
    expect(initialLiveCommittedCount([thought, brief, tool])).toBe(2);
  });

  it('commits everything once markdown has started', () => {
    expect(initialLiveCommittedCount([thought, tool, md])).toBe(2);
  });

  it('keeps a trailing tool batch in one preview', () => {
    expect(initialLiveCommittedCount([thought, tool, tool2, tool3])).toBe(1);
    expect(initialLiveCommittedCount([tool, tool2, tool3])).toBe(0);
  });
});

describe('firstQueueableIdentity', () => {
  it('resets when the feed is empty', () => {
    expect(firstQueueableIdentity([])).toBeNull();
    expect(firstQueueableIdentity([thought, tool])).toBe('thought:reasoning');
  });
});

describe('hasCommitPressure', () => {
  it('is true when inbound is waiting or markdown has started', () => {
    expect(hasCommitPressure([thought], thought, [])).toBe(false);
    expect(hasCommitPressure([thought, tool], thought, [tool])).toBe(true);
    expect(hasCommitPressure([thought, md], thought, [])).toBe(true);
  });

  it('is false while only sibling tools are inbound', () => {
    expect(hasCommitPressure([tool, tool2], tool, [tool2])).toBe(false);
    expect(hasCommitPressure([tool, tool2, md], tool, [tool2])).toBe(true);
  });
});

describe('decidePreviewCommit', () => {
  const base = {
    live: true,
    items: [thought, tool] as TurnFeedItem[],
    current: thought,
    inbound: [tool],
    previewStartedAt: 0,
    lastGrowthAt: 0,
    inboundAppearedAt: 0,
  };

  it('stays while there is no inbound and no markdown', () => {
    expect(
      decidePreviewCommit({
        ...base,
        items: [thought],
        inbound: [],
        now: 10_000,
      }),
    ).toEqual({ action: 'stay' });
  });

  it('stays on a tool batch until a later event arrives', () => {
    expect(
      decidePreviewCommit({
        ...base,
        items: [tool, tool2],
        current: tool,
        inbound: [tool2],
        now: 10_000,
      }),
    ).toEqual({ action: 'stay' });
  });

  it('waits until dwell and idle elapse when inbound is present', () => {
    expect(decidePreviewCommit({ ...base, now: 100 })).toEqual({
      action: 'wait',
      delayMs: PREVIEW_OPEN_DWELL_MS - 100,
    });
    expect(
      decidePreviewCommit({
        ...base,
        now: PREVIEW_OPEN_DWELL_MS,
        lastGrowthAt: PREVIEW_OPEN_DWELL_MS - 10,
      }),
    ).toEqual({ action: 'wait', delayMs: PREVIEW_IDLE_MS - 10 });
  });

  it('waits to paint the dashed inbound even when dwell already elapsed', () => {
    expect(
      decidePreviewCommit({
        ...base,
        now: 10_000,
        lastGrowthAt: 9_000,
        inboundAppearedAt: 10_000,
      }),
    ).toEqual({ action: 'wait', delayMs: PREVIEW_INBOUND_ANNOUNCE_MS });
  });

  it('commits after dwell, idle, and inbound announce when inbound is waiting', () => {
    expect(
      decidePreviewCommit({
        ...base,
        now: PREVIEW_OPEN_DWELL_MS + PREVIEW_IDLE_MS + PREVIEW_INBOUND_ANNOUNCE_MS,
        lastGrowthAt: PREVIEW_OPEN_DWELL_MS,
        inboundAppearedAt: PREVIEW_OPEN_DWELL_MS,
      }),
    ).toEqual({ action: 'commit' });
  });

  it('flushes when live ends', () => {
    expect(decidePreviewCommit({ ...base, live: false, now: 0 })).toEqual({ action: 'flush' });
  });

  it('commits HITL immediately', () => {
    expect(
      decidePreviewCommit({
        ...base,
        current: hitl,
        inbound: [thought],
        now: 0,
      }),
    ).toEqual({ action: 'commit' });
  });
});
