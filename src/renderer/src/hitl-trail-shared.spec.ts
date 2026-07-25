import { describe, expect, it } from 'vitest';
import { diffLineChangeCounts, formatDiffLineChangeSummary } from '../../shared/diff-stats';
import {
  hitlTrailItemsFromArtifacts,
  hitlTrailPanelTitle,
  hitlTrailRowKindText,
  mergeHitlTrailIntoAuxiliaryTimeline,
} from '../../shared/hitl-trail';
import { HITL_TRAIL_STREAM_PREFIX, isHitlTrailStreamTag } from '../../shared/stream-parts';
import type { DiffRow } from '../../shared/types/diff';

describe('diffLineChangeCounts', () => {
  it('counts add, remove, and replace rows', () => {
    const rows: DiffRow[] = [
      { kind: 'equal', leftLine: 1, rightLine: 1, leftText: 'a', rightText: 'a', hunkIndex: 0 },
      { kind: 'add', leftLine: null, rightLine: 2, leftText: '', rightText: 'b', hunkIndex: 1 },
      { kind: 'remove', leftLine: 3, rightLine: null, leftText: 'c', rightText: '', hunkIndex: 1 },
      { kind: 'replace', leftLine: 4, rightLine: 4, leftText: 'd', rightText: 'e', hunkIndex: 2 },
    ];
    expect(diffLineChangeCounts(rows)).toEqual({ additions: 2, deletions: 2 });
  });
});

describe('formatDiffLineChangeSummary', () => {
  it('formats git-style deltas', () => {
    expect(formatDiffLineChangeSummary({ additions: 12, deletions: 4 })).toBe('+12 −4');
    expect(formatDiffLineChangeSummary({ additions: 0, deletions: 0 })).toBe('0');
  });
});

describe('hitlTrailItemsFromArtifacts', () => {
  it('maps diff artifacts to filename and line summary', () => {
    const rows: DiffRow[] = [
      { kind: 'add', leftLine: null, rightLine: 1, leftText: '', rightText: 'x', hunkIndex: 0 },
      { kind: 'remove', leftLine: 2, rightLine: null, leftText: 'y', rightText: '', hunkIndex: 0 },
    ];
    const items = hitlTrailItemsFromArtifacts([
      {
        role: 'diff',
        payload: {
          version: 1,
          relativePath: 'src/foo/bar.ts',
          language: 'typescript',
          rows,
          fullNewContent: 'x',
          truncated: false,
        },
      },
    ]);
    expect(items[0]?.label).toBe('bar.ts');
    expect(items[0]?.lineSummary).toBe('+1 −1');
    expect(hitlTrailRowKindText(items[0]!)).toBe('edit +1 −1');
  });
});

describe('hitlTrailRowKindText', () => {
  it('merges resolved status into the kind pill', () => {
    const items = hitlTrailItemsFromArtifacts([
      {
        role: 'diff',
        payload: {
          version: 1,
          relativePath: 'a.ts',
          language: 'typescript',
          rows: [{ kind: 'add', leftLine: null, rightLine: 1, leftText: '', rightText: 'x', hunkIndex: 0 }],
          fullNewContent: 'x',
          truncated: false,
        },
        reviewStatus: 'complete',
      },
    ]);
    expect(hitlTrailRowKindText(items[0]!)).toBe('edit +1 ok');
  });
});

describe('hitlTrailPanelTitle', () => {
  it('shows pending count while live', () => {
    const items = hitlTrailItemsFromArtifacts([
      {
        role: 'diff',
        payload: {
          version: 1,
          relativePath: 'a.ts',
          language: 'typescript',
          rows: [],
          fullNewContent: '',
          truncated: false,
        },
      },
    ]);
    expect(hitlTrailPanelTitle(items, true)).toBe('1 pending');
  });
});

describe('mergeHitlTrailIntoAuxiliaryTimeline', () => {
  it('appends hitl-trail parts after existing stream parts', () => {
    const merged = mergeHitlTrailIntoAuxiliaryTimeline(
      [{ streamTag: 'reasoning', label: 'Model reasoning', text: 'thinking' }],
      [
        {
          role: 'diff',
          payload: {
            version: 1,
            relativePath: 'src/a.ts',
            language: 'typescript',
            rows: [{ kind: 'add', leftLine: null, rightLine: 1, leftText: '', rightText: 'x', hunkIndex: 0 }],
            fullNewContent: 'x',
            truncated: false,
          },
        },
      ],
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]?.streamTag).toBe('reasoning');
    expect(isHitlTrailStreamTag(merged[1]!.streamTag)).toBe(true);
    expect(merged[1]!.streamTag.startsWith(HITL_TRAIL_STREAM_PREFIX)).toBe(true);
    expect(merged[1]!.label).toBe('a.ts');
    expect(merged[1]!.text).toBe('edit +1');
    expect(merged[1]!.toolChainState).toBe('running');
  });

  it('skips plan_confirm and agent_question artifacts', () => {
    const merged = mergeHitlTrailIntoAuxiliaryTimeline([], [
      {
        role: 'plan_confirm',
        payload: {
          version: 1,
          requestId: 'p1',
          title: 'Plan',
          message: '',
          confirmLabel: 'Go',
          cancelLabel: 'Cancel',
          steps: [],
          filesToChange: [],
          currentImplementation: '',
          risks: [],
          definitionOfDone: [],
          resolvedQuestions: [],
        },
      },
      {
        role: 'agent_question',
        payload: {
          version: 1,
          requestId: 'q1',
          title: 'Q',
          message: '',
          submitLabel: 'Submit',
          cancelLabel: 'Cancel',
          questions: [],
        },
      },
    ]);
    expect(merged).toEqual([]);
  });

  it('updates hitl-trail status in place without moving the row', () => {
    const first = mergeHitlTrailIntoAuxiliaryTimeline(
      [{ streamTag: 'reasoning', label: 'r', text: 'x' }],
      [
        {
          role: 'diff',
          payload: {
            version: 1,
            relativePath: 'a.ts',
            language: 'typescript',
            rows: [],
            fullNewContent: '',
            truncated: false,
          },
        },
      ],
    );
    const withLaterReasoning = [
      ...first,
      { streamTag: 'reasoning', label: 'r', text: 'more' },
      { streamTag: 'tool-trail:t1', label: 'read_workspace_file', text: 'Reading…' },
    ];
    const second = mergeHitlTrailIntoAuxiliaryTimeline(withLaterReasoning, [
      {
        role: 'diff',
        payload: {
          version: 1,
          relativePath: 'a.ts',
          language: 'typescript',
          rows: [],
          fullNewContent: '',
          truncated: false,
        },
        reviewStatus: 'complete',
      },
    ]);
    expect(second.map((p) => p.streamTag)).toEqual([
      'reasoning',
      first[1]!.streamTag,
      'reasoning',
      'tool-trail:t1',
    ]);
    expect(second[1]?.toolChainState).toBe('complete');
    expect(second[1]?.text).toContain('ok');
  });

  it('keeps approved hitl rows interleaved when more stream parts arrive', () => {
    const afterHitl = mergeHitlTrailIntoAuxiliaryTimeline(
      [
        { streamTag: 'reasoning', label: 'r', text: 'before' },
        { streamTag: 'tool-trail:t0', label: 'search_workspace', text: 'Searching…' },
      ],
      [
        {
          role: 'diff',
          payload: {
            version: 1,
            relativePath: 'src/a.ts',
            language: 'typescript',
            rows: [],
            fullNewContent: '',
            truncated: false,
          },
          reviewStatus: 'complete',
        },
      ],
    );
    const continued = mergeHitlTrailIntoAuxiliaryTimeline(
      [
        ...afterHitl,
        { streamTag: 'reasoning', label: 'r', text: 'after approval' },
      ],
      [
        {
          role: 'diff',
          payload: {
            version: 1,
            relativePath: 'src/a.ts',
            language: 'typescript',
            rows: [],
            fullNewContent: '',
            truncated: false,
          },
          reviewStatus: 'complete',
        },
      ],
    );
    expect(continued.map((p) => p.streamTag)).toEqual([
      'reasoning',
      'tool-trail:t0',
      afterHitl[2]!.streamTag,
      'reasoning',
    ]);
    expect(continued[2]?.label).toBe('a.ts');
  });
});
